'use strict';

var Base = require('./base');
var fs = require('fs');
// var path = require('path');
var util = require('./download-job-util');
// var isDebug = process.env.NODE_ENV == 'development';
var commonUtil = require('./util');
var RETRYTIMES = commonUtil.getRetryTimes();
// var fdSlicer = require('fd-slicer');
var stream = require('stream');
const DataCache = require('./DataCache');

function getNextPart(chunks) {
  return chunks.shift();
}

function hasNextPart(chunks) {
  return chunks.length > 0;
}


class DownloadJob extends Base {

  /**
   *
   * @param ossClient
   * @param config
   *    config.from {object|string}  {bucket, key} or oss://bucket/test/a.jpg
   *    config.to   {object|string}  {name, path} or /home/admin/a.jpg
   *    config.checkPoint
   *
   *    config.chunkSize
   *    config.enableCrc64
   */
  constructor(ossClient, config, aliOSS) {
    super();
    this.id = 'dj-' + new Date().getTime() + '-' + (('' + Math.random()).substring(2));
    this.oss = ossClient;
    this.aliOSS = aliOSS;
    this._config = {};
    Object.assign(this._config, config);

    if (!this._config.from) {
      console.log('需要 from');
      return;
    }
    if (!this._config.to) {
      console.log('需要 to');
      return;
    }

    this.from = util.parseOssPath(this._config.from); //oss path
    this.to = util.parseLocalPath(this._config.to); //local path
    this.region = this._config.region;

    this.prog = this._config.prog || {
      loaded: 0,
      total: 0
    };

    this.message = this._config.message;
    this.status = this._config.status || 'waiting';

    this.stopFlag = this.status != 'running';

    this.checkPoints = this._config.checkPoints;
    this.enableCrc64 = this._config.enableCrc64;

    //console.log('created download job');

    this.maxConcurrency = parseInt(localStorage.getItem('downloadConcurrecyPartSize') || 15)

    this.crc64List = [];
    this.crc64Promise = [];

    // 正在写文件状态
    this.writing = false;
    // // 文件写入的分片位置
    // this.writePos = 1;
  }
}

DownloadJob.prototype.start = function () {
  var self = this;
  if (this.status == 'running') return;

  if (this._lastStatusFailed) {
    //从头开始
    this.checkPoints = {};
    this.crc64Str = '';
    this.crc64Promise = [];
    this.crc64List = [];
    this.writing = false;
    // this.writePos = 1;
  }

  self.message = '';
  self.startTime = new Date().getTime();
  self.endTime = null;

  self.stopFlag = false;
  self._changeStatus('running');

  self.checkPoints = (self.checkPoints && self.checkPoints.Parts) ? self.checkPoints : {
    from: self.from,
    to: self.to,
    Parts: {}
  };

  self.startDownload(self.checkPoints);

  self.dataCache = new DataCache();

  return self;
};

/**
 * 开始download
 */
DownloadJob.prototype.startDownload = async function (checkPoints) {
  var self = this;

  self._log_opt = {}

  var chunkNum = 0;
  var chunkSize = 0;
  //var keepFd;
  var chunks = [];

  var maxRetries = RETRYTIMES;

  var concurrency = 0;

  var tmpName = self.to.path + '.download';
  var fileMd5 = '';
  var hashCrc64ecma = '';

  var objOpt = {
    Bucket: self.from.bucket,
    Key: self.from.key
  };
  this.aliOSS.useBucket(self.from.bucket);
  let headers;
  try {
    headers = await util.headObject(self, objOpt);
  } catch (err) {
    if (err.message.indexOf('Network Failure') != -1
      || err.message.indexOf('getaddrinfo ENOTFOUND') != -1) {
      self.message = 'failed to get oss object meta: ' + err.message;
      console.error(self.message, self.to.path);
      self.stop();
      //self.emit('error', err);
    } else {
      self.message = 'failed to get oss object meta: ' + err.message;
      console.error(self.message, self.to.path);
      self._changeStatus('failed');
      self.emit('error', err);
    }
    return;
  }

  // fileMd5 = headers['content-md5'];//.replace(/(^\"*)|(\"*$)/g, '');
  //console.log('file md5:',fileMd5);
  hashCrc64ecma = headers['x-oss-hash-crc64ecma'];
  if (self.hashCrc64ecma && self.hashCrc64ecma !== hashCrc64ecma) {
    // 做下判断，防止原始文件发生变更
    self.message = '文件已经发生变更，新重新下载该文件';
    console.error(self.message, self.to.path);
    self._changeStatus('failed');
    return false;
  }
  self.hashCrc64ecma = hashCrc64ecma;

  const contentLength = parseInt(headers['content-length']);
  self.prog.total = contentLength;
  //空文件
  if (self.prog.total == 0) {

    fs.writeFile(self.to.path, '', function (err) {
      if (err) {
        self.message = 'failed to open local file:' + err.message;
        //console.error(self.message);
        console.error(self.message, self.to.path);
        self._changeStatus('failed');
        self.emit('error', err);

      } else {
        self._changeStatus('finished');
        self.emit('progress', {
          total: 0,
          loaded: 0
        });
        self.emit('partcomplete', {
          total: 0,
          done: 0
        });
        self.emit('complete');
        console.log('download: ' + self.to.path + ' %celapse', 'background:green;color:white', self.endTime - self.startTime, 'ms')

      }
    });
    return;
  }

  if (self.stopFlag) {
    return;
  }

  chunkSize = checkPoints.chunkSize || self._config.chunkSize || util.getSensibleChunkSize(self.prog.total);

  // chunkSize = 4 * 1024 * 1024;
  // chunkSize = 4 * 1024;
  // self.chunkSize=chunkSize;

  chunkNum = Math.ceil(self.prog.total / chunkSize);

  chunks = [];

  let p = 0;
  for (var i = 0; i < chunkNum; i++) {
    if (!checkPoints.Parts[i + 1] || !checkPoints.Parts[i + 1].done) {
      chunks.push(i);
      let size = chunkSize;
      if (chunkNum === 1) {
        size = chunkSize;
      } else if (i + 1 === chunkNum) {
        size = self.prog.total % chunkSize;
      }
      checkPoints.Parts[i + 1] = {
        PartNumber: i + 1, // 分片序号
        loaded: 0,         // 该分片已经写盘长度
        size: size,   // 该分片需要写盘的长度，用于判断分片是否完成
        done: false,       // 该分片是否已经下载并完成写盘
        position: p        // 该分片中下一个 data 需要写入文件中的位置
      };
      // p += chunkSize;
    }
    p += chunkSize;
  }

  //之前每个part都已经全部下载完成，状态还没改成完成的, 这种情况出现几率极少。
  if (self.prog.loaded === self.prog.total) {
    self._calProgress(checkPoints);
    self._changeStatus('verifying');
    await self._complete(tmpName, hashCrc64ecma, checkPoints);
    return;
  }

  try {
    util.createFileIfNotExists(tmpName);
  } catch (err) {
    self.message = 'failed to open local file:' + err.message;
    console.error(self.message, self.to.path);
    self._changeStatus('failed');
    self.emit('error', err);
    return;
  }
  if (self.stopFlag) {
    return;
  }
  const fd = fs.openSync(tmpName, 'r+');
  self.fd = fd;

  util.getFreeDiskSize(tmpName, function (err, freeDiskSize) {
    console.log('got free disk size:', freeDiskSize, contentLength, freeDiskSize - contentLength)
    if (!err) {
      if (contentLength > freeDiskSize - 10 * 1024 * 1024) {
        // < 100MB warning
        self.message = "Insufficient disk space";
        self.stop();
        return;
      }
    }

    self.startSpeedCounter();
    downloadPart(getNextPart(chunks));
  });

  function downloadPart(n) {
    if (n == null) return;

    const partNumber = n + 1;
    if (checkPoints.Parts[partNumber].done) {
      console.log(`part [${n}] has finished`);
      return;
    }

    var start = chunkSize * n;
    var end = (n + 1 < chunkNum) ? start + chunkSize : self.prog.total;

    var retryCount = 0;

    concurrency++;
    doDownload(n);

    if (hasNextPart(chunks) && concurrency < self.maxConcurrency) {
      downloadPart(getNextPart(chunks));
    }

    function doDownload(n) {
      if (n == null) return;

      if (self.stopFlag) {
        return;
      }

      // self._log_opt[partNumber] = {
      //   start: Date.now()
      // };
      const part = checkPoints.Parts[partNumber];
      console.log(part, 'part download');

      self.aliOSS.getStream(objOpt.Key, {
        headers: {
          Range: `bytes=${start}-${end - 1}`
        }
      }).then((res) => {
        if (self.stopFlag) {
          return;
        }
        res.stream.on('data', function (chunk) {
          if (self.stopFlag) {
            res.stream.destroy();
            return;
          }
          // 用来计算下载速度
          self.downloaded = (self.downloaded || 0) + chunk.length;
          self.dataCache.push(partNumber,chunk);
          writePartData();
        }).on('end', async function() {
          if (self.stopFlag) {
            return;
          }
          // writePartData();
          concurrency --;
          downloadPartByMemoryLimit();
        }).on('error', _handleError);
        self._calPartCRC64Stream(res.stream, partNumber, end - start);
      }).catch(_handleError);

      function downloadPartByMemoryLimit() {
        // 网络下载快于磁盘读写，sleep 防止内存占用过大
        if (self.dataCache.size() <  self.maxConcurrency && hasNextPart(chunks)) {
          downloadPart(getNextPart(chunks));
        } else {
          setTimeout(() => {
            console.log(self.dataCache);
            downloadPartByMemoryLimit()
          }, 1000)
        }
      }

      async function writePartData() {
        const { writing, checkPoints } = self;
        // 保证只有一个写操作
        if (writing) {
          return false;
        }
        const dataInfo = self.dataCache.shift();
        if (!dataInfo) {
            return;
        }
        const {partNumber, data, length} = dataInfo;
        const part = checkPoints.Parts[partNumber];
        self.writing = true;
        fs.write(self.fd, data, 0, length, part.position, function (err, bytesWritten) {
          if (err) {
            console.error(err, 'err');
            return false;
          }
          if (bytesWritten !== length) {
            console.error('the chunk data are not full written');
            return false;
          }
          self.writing = false;
          part.loaded =+ part.loaded + length;
          part.position += length;
          if (part.loaded === part.size) {
            part.done = true;
          } else {
            part.done = false;
          }
          self._calProgress(checkPoints);
          if (self.prog.loaded === self.prog.total) {
            //  下载完成
            self._changeStatus('verifying');
            // 确保所有crc64已经校验完成
            self._complete(tmpName, hashCrc64ecma, checkPoints);
          } else {
            writePartData();
          }
        })
      }

      function _handleError(err) {
        console.error('download error', err)
        checkPoints.Parts[partNumber].loaded = 0;
        checkPoints.Parts[partNumber].done = false;
        // TODO code 状态码修复
        if (err.code == 'RequestAbortedError') {
          // 必须用callback 而不是 promise 方式才能 abort 请求;
          //用户取消
          console.warn('用户取消');
          return;
        }

        if (retryCount >= maxRetries) {
          self.message = `failed to download part [${n}]: ${err.message}`;
          //console.error(self.message);
          console.error(self.message, self.to.path);
          //self._changeStatus('failed');
          self.stop();
          //self.emit('error', err);
          //util.closeFD(keepFd);
        } else if (err.code == 'InvalidObjectState') {
          self.message = `failed to download part [${n}]: ${err.message}`;
          //console.error(self.message);
          console.error(self.message, self.to.path);
          self._changeStatus('failed');
          self.emit('error', err);
          //util.closeFD(keepFd);
        } else {
          retryCount++;
          console.log(`retry download part [${n}] error:${err}, ${self.to.path}`);
          setTimeout(function () {
            doDownload(n);
          }, 2000);
        }
      }
    }
  }
};


/**
 * 异步计算分片crc64
 * @param s
 * @private
 */
DownloadJob.prototype._calPartCRC64Stream = function (s, partNumber, len) {
  const streamCpy = s.pipe(new stream.PassThrough());
  const self = this;
  const start = new Date();
  const res = util.getStreamCrc64(streamCpy).then(data => {
    self.crc64List[partNumber - 1] = {
      crc64: data,
      len: len
    }
    console.log(`part [${partNumber}] crc64 finish use: '${((+new Date()) - start)} ms, crc64 is ${data}`, self.crc64List);
  }).catch(err => {
    self.message = '分片校验失败';
    self.checkPoints.Parts[partNumber].loaded = 0;
    self.checkPoints.Parts[partNumber].done = false;
    console.error(self.message, self.to.path, err);
    self.stop();
    self._changeStatus('failed');
    self.emit('error', err);
  })
  if (self.stopFlag) {
    return;
  }
  self.crc64Promise.push(res);
  return res;
}

/**
 * 计算当前下载进度
 * @param checkPoints
 * @private
 */
DownloadJob.prototype._calProgress = function (checkPoints) {
  var loaded = 0;
  for (var k in checkPoints.Parts) {
    loaded += checkPoints.Parts[k].loaded;
  }
  this.prog.loaded = loaded;
  this.emit('progress', this.prog);
}

/**
 * 完成文件下载及校验
 * @param tmpName
 * @param hashCrc64ecma
 * @param checkPoints
 * @returns {Promise<void>}
 * @private
 */
DownloadJob.prototype._complete = async function (tmpName, hashCrc64ecma, checkPoints) {
  // 确保所有crc64已经校验完成
  const start = new Date();
  const self = this;
  try {
    await Promise.all(self.crc64Promise);
    const res = await util.combineCrc64(self.crc64List);
    console.log('combine crc64  use: ' + ((+new Date()) - start) + 'ms');
    if (res === hashCrc64ecma) {
      //临时文件重命名为正式文件
      try {
        fs.renameSync(tmpName, self.to.path);
      } catch (err) {
        const stats = fs.statSync(tmpName);
        const fileSize = stats.size;
        if (fileSize === self.prog.total) {
          // 文件已经下载完, 长度也正确，没必要重新下载，暂停即可
          console.log('rename error', err);
          self.message = '文件重名失败: ' + err.message;
          self.stop();
          return;
        } else {
          // 其他错误，重新下载文件
          err.message = '文件重命名失败';
          throw err;
        }
      }
      self._changeStatus('finished');
      //self.emit('progress', progCp);
      self.emit('partcomplete', util.getPartProgress(checkPoints.Parts), checkPoints);
      self.emit('complete');
      util.closeFD(self.fd);
      console.log('download: ' + self.to.path + ' %celapse', 'background:green;color:white', self.endTime - self.startTime, 'ms')
    } else {
      const error = new Error();
      error.message = '文件校验不匹配，请删除文件重新下载';
      throw error;
    }
  } catch (err) {
    self.message = (err.message || err);
    console.error(self.message, self.to.path, self.crc64List);
    self._changeStatus('failed');
    self.emit('error', err);
  }
}

DownloadJob.prototype.stop = function () {
  var self = this;
  if (self.status == 'stopped') return;
  self.stopFlag = true;
  self._changeStatus('stopped');
  self.speed = 0;
  self.predictLeftTime = 0;
  return self;
};

DownloadJob.prototype.wait = function () {
  var self = this;
  if (this.status == 'waiting') return;
  this._lastStatusFailed = this.status == 'failed';
  self.stopFlag = true;
  self._changeStatus('waiting');
  return self;
};

DownloadJob.prototype._changeStatus = function (status, retryTimes) {
  var self = this;
  self.status = status;
  self.emit('statuschange', self.status, retryTimes);

  if (status == 'failed' || status == 'stopped' || status == 'finished') {
    self.endTime = new Date().getTime();
    //util.closeFD(self.keepFd);

    console.log('clear speed tid, status:', self.status)
    clearInterval(self.speedTid);
    self.speed = 0;
    //推测耗时
    self.predictLeftTime = 0;
  }
};

DownloadJob.prototype.startSpeedCounter = function () {
  const self = this;

  self.lastLoaded = self.downloaded || 0;
  self.lastSpeed = 0;

  // 防止速度计算发生抖动，
  self.speeds = [];
  let tick = 0;
  clearInterval(self.speedTid);
  self.speedTid = setInterval(function () {

    if (self.stopFlag) {
      self.speed = 0;
      self.speeds = [];
      self.predictLeftTime = 0;
      return;
    }

    self.speed = self.downloaded - self.lastLoaded;
    self.speeds[tick] = self.speed;
    const speedsAll = self.speeds.filter(i => typeof i === 'number');
    let speedAvg = 0;
    if (speedsAll.length !== 0) {
      speedAvg = speedsAll.reduce((acc, cur) => acc + cur) /  speedsAll.length;
    }
    if (self.lastSpeed != speedAvg) self.emit('speedChange', speedAvg);
    self.lastSpeed = speedAvg;
    self.lastLoaded = self.downloaded;

    //推测耗时
    self.predictLeftTime = speedAvg == 0 ? 0 : Math.floor((self.prog.total - self.prog.loaded) / speedAvg * 1000);

    //根据speed 动态调整 maxConcurrency, 5秒修改一次
    tick++;
    if (tick > 5) {
      tick = 0;
      self.maxConcurrency = util.computeMaxConcurrency(self.speed, self.chunkSize, self.maxConcurrency);
      // console.log('max concurrency:', self.maxConcurrency);
    }
  }, 1000);

  // function onFinished() {
  //   clearInterval(self.speedTid);
  //   self.speed = 0;
  //   //推测耗时
  //   self.predictLeftTime = 0;
  // }
  //
  // self.on('stopped', onFinished);
  // self.on('error', onFinished);
  // self.on('complete', onFinished);
};

module.exports = DownloadJob;
