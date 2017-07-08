'use strict';


var fs = require('fs');
var path = require('path');
var util = require('./util');

module.exports = {
  genUploadNumArr: genUploadNumArr,
  prepareChunks:prepareChunks,
  getSensibleChunkSize: getSensibleChunkSize,
  parseLocalPath: util.parseLocalPath,
  parseOssPath: util.parseOssPath,

  getPartProgress: getPartProgress,
  checkAllPartCompleted: checkAllPartCompleted,
  closeFD: util.closeFD,

  getUploadId: getUploadId,
  completeMultipartUpload: completeMultipartUpload,

  getFileCrc64: getFileCrc64,
  computeMaxConcurrency: computeMaxConcurrency
};



/*************************************
 //  以下是纯函数
 ************************************/

//根据网速调整上传并发量
function computeMaxConcurrency(speed){
  if(speed > 8*1024*1024) return 10;
  else if(speed > 5*1024*1024) return 7;
  else if(speed > 2*1024*1024) return 5;
  else return 3;
}

function getFileCrc64(self, p, fn){
  if(self.crc64Str){
    fn(null, self.crc64Str);
    return;
  }
   var retryTimes = 0;
   _dig();
   function _dig(){
     util.getFileCrc64(p,function(err,data){
       if(err){
         if(retryTimes>5){
           fn(err);
         }else{
           retryTimes ++;
           setTimeout(function(){
             if(!self.stopFlag)_dig();
           },1000);
         }
       }else{
         fn(null,data);
       }
     });
   }
};


function getPartProgress(checkPoints){
  var total = checkPoints.chunks.length;
  var c=0;
  for(var k in checkPoints.Parts){
    if(checkPoints.Parts[k].ETag) c++;
  }

  return {
    done: c, total: total
  };
}

function checkAllPartCompleted(checkPoints){
  var prog = getPartProgress(checkPoints);
  return prog.done==prog.total;
}


function completeMultipartUpload(self, doneParams ,fn){
  var retryTimes  = 0;
  _dig();
  function _dig(){
    self.oss.completeMultipartUpload(doneParams, function(err, data){

      if (err) {
        if(err.message.indexOf('The specified upload does not exist')!=-1){

          self.oss.headObject({
            Bucket: self.to.bucket,
            Key: self.to.key
          }, function(err2, data2){
            //console.log('headobject: ', err2, err2.message, data);
            if(err2){
              fn(err2);
            }else{
              fn(null, data2);
            }
          });
          return;
        }

        if(retryTimes > 10){
          fn(err);
        }else{
          retryTimes++;
          console.error('completeMultipartUpload error', err, ', ----- retrying...', retryTimes+'/'+10);
          setTimeout(function(){
            if(!self.stopFlag) _dig();
          },2000);
        }
      }
      else{
        fn(null, data);
      }
    });
  };
}

function getUploadId(checkPoints, self, params, fn){

  if(checkPoints.uploadId){
    fn(null, checkPoints.uploadId);
    return;
  }

  var retryTimes  = 0;
  _dig();
  function _dig(){
    self.oss.createMultipartUpload(params, function (err, res) {

      //console.log(err, res, '<========')
      if (err) {
        if(retryTimes > 10){
          fn(err);
        }else{

          retryTimes++;
          console.warn('createMultipartUpload error', err, ', ----- retrying...', retryTimes+'/'+10);
          setTimeout(function(){
            if(!self.stopFlag)_dig();
          },2000);
        }
        return;
      }
      else{
        checkPoints.uploadId = res.UploadId;
        fn(null, res.UploadId);
      }
    });
  }
}

function genUploadNumArr(result){
  var parts = result.Parts;
  var chunkNum = result.chunks.length;

  var mDone = {};
  var mHas={};
  if(parts){
    for(var k in parts){
      if(parts[k].ETag) {
        mDone[k] = parts[k].ETag;
      }
      mHas[k]=parts[k];
    }
  }

  var t=[];
  for(var i=0;i<chunkNum;i++){
    if(!mDone[(i+1)+'']){
      t.push(i);
    }

    if(!mHas[(i+1)+'']){
      parts[(i+1)+'']={
        PartNumber: i + 1,
        loaded: 0
      };
    }
  }
  return t;
}



function prepareChunks(filePath, checkPoints, fn){

  checkPoints = checkPoints || {};

  var fileName = path.basename(filePath);

  fs.stat(filePath, function(err, state) {
    if (err) {
      callback(err);
      return;
    }

    var chunkSize = checkPoints.chunkSize  || getSensibleChunkSize(state.size);
    var chunkNum = state.size > chunkSize ? Math.ceil(state.size / chunkSize) : 1;

    //console.log('chunkSize: ', chunkSize, "chunkNum: ", chunkNum);

    var chunks = [];

    for (var i = 0; i < chunkNum; i++) {
      var start = i * chunkSize;
      chunks[i] = {
        start: start,
        len: (i + 1 == chunkNum) ? (state.size - start) : chunkSize
      };
    }

    fn(null, {
      chunks: chunks,
      chunkSize: chunkSize,
      Parts: checkPoints.Parts || {},
      uploadId: checkPoints.uploadId || null,
      file: {
        name: fileName,
        size: state.size,
        path: filePath
      }
    });

  });
}



/**
 * @param total size
 */
function getSensibleChunkSize(total) {

  var minChunkSize = 5 * 1024 * 1024;  //5MB
  if(total <= minChunkSize){
    return minChunkSize;
  }

  var parts = Math.ceil(total / minChunkSize);
  if (parts > 10000) {
    return Math.ceil(total / 10000);
  }

  return minChunkSize;
}