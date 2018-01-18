'use strict';

var util = require('util'),
    assert = require('assert'),
    retryFn = require('retry-fn'),
    FlushWritable = require('flushwritable'),
    _ = require('lodash');

util.inherits(KinesisWritable, FlushWritable);

/**
 * A simple stream wrapper around Kinesis putRecords
 *
 * @param {AWS.Kinesis} client AWS Kinesis client
 * @param {string} streamName Kinesis stream name
 * @param {Object} options Options
 * @param {number} [options.highWaterMark=16] Number of items to buffer before writing.
 * Also the size of the underlying stream buffer.
 * @param {Number} [options.maxRetries=3] How many times to retry failed data before
 * rasing an error
 * @param {Number} [options.retryTimeout=100] How long to wait initially before
 * retrying failed records
 * @param {number} [options.flushTimeout=null] Number of ms to flush records after, if highWaterMark hasn't been reached
 * @param {Object} [options.logger] Instance of a logger like bunyan or winston
 */
function KinesisWritable(client, streamName, options) {
    assert(client, 'client is required');
    assert(streamName, 'streamName is required');

    options = options || {};
    options.objectMode = true;

    FlushWritable.call(this, options);

    this.client = client;
    this.streamName = streamName;
    this.logger = options.logger || null;
    this.highWaterMark = options.highWaterMark || 16;
    this.flushTimeout = options.flushTimeout || null;
    this.maxRetries = options.maxRetries || 3;

    // The maximum number of items that can be written to Kinesis in
    // one request is 500
    assert(this.highWaterMark <= 500, 'Max highWaterMark is 500');

    this.queue = [];
}

/* eslint-disable no-unused-vars */

/**
 * Get partition key for given record
 *
 * @param {Object} [record] Record
 * @return {string}
 */
KinesisWritable.prototype.getPartitionKey = function getPartitionKey(record) {
    return _.padLeft(_.random(0, 1000), 4, '0');
};

/* eslint-enable no-unused-vars */

/**
 * Transform record into one accepted by Kinesis
 *
 * @private
 * @param {Object} record
 * @return {Object}
 */
KinesisWritable.prototype.transformRecord = function transformRecord(record) {
    return {
        Data: JSON.stringify(record),
        PartitionKey: this.getPartitionKey(record)
    };
};

/**
 * Write records in queue to Kinesis
 *
 * @private
 * @param {Function} callback
 */
KinesisWritable.prototype.writeRecords = function writeRecords(callback) {
    if (this.logger) {
        this.logger.debug('Writing %d records to Kinesis', this.queue.length);
    }

    var recordsToWrite = this.queue.splice(0);
    var records = recordsToWrite.map(this.transformRecord.bind(this));

    this.client.putRecords({
        Records: records,
        StreamName: this.streamName
    }, function(err, response) {
        if (err) {
            return callback(err);
        }

        if (this.logger) {
            this.logger.info('Wrote %d records to Kinesis',
                records.length - response.FailedRecordCount);
        }

        if (response.FailedRecordCount !== 0) {
            if (this.logger) {
                this.logger.warn('Failed writing %d records to Kinesis',
                    response.FailedRecordCount);
            }

            var failedRecords = [];

            response.Records.forEach(function(record, index) {
                if (record.ErrorCode) {
                    if (this.logger) {
                        this.logger.warn('Failed record with message: %s', record.ErrorMessage);
                    }

                    failedRecords.push(recordsToWrite[index]);
                }
            }.bind(this));

            this.queue = this.queue.concat(failedRecords);

            return callback(new Error('Failed to write ' + failedRecords.length + ' records'));
        }

        callback();
    }.bind(this));
};

/**
 * Flush method needed by the underlying stream implementation
 *
 * @private
 * @param {Function} callback
 * @return {undefined}
 */
KinesisWritable.prototype._flush = function _flush(callback) {
    clearTimeout(this.flushTimeoutId);

    if (this.queue.length === 0) {
        return callback();
    }

    var retry = retryFn.bind(null, {
        retries: this.maxRetries,
        timeout: retryFn.fib(this.retryTimeout)
    });

    retry(this.writeRecords.bind(this), callback);
};

/**
 * Write method needed by the underlying stream implementation
 *
 * @private
 * @param {Object} record
 * @param {string} enc
 * @param {Function} callback
 * @returns {undefined}
 */
KinesisWritable.prototype._write = function _write(record, enc, callback) {
    if (this.logger) {
        this.logger.debug('Adding to Kinesis queue', { record: record });
    }
    this.queue.push(record);

    if (this.queue.length >= this.highWaterMark) {
        return this._flush(callback);
    }

    if (this.queue.length >= this.highWaterMark) {
        return this._flush(callback);
    } else if (this.flushTimeout) {
        clearTimeout(this.flushTimeoutId);

        this.flushTimeoutId = setTimeout(function() {
            this._flush(function(err) {
                if (err) {
                    this.emit('error', err);
                }
            }.bind(this));
        }.bind(this), this.flushTimeout);
    }

    callback();
};

module.exports = KinesisWritable;
