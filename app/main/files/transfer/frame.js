
angular.module('web')
.controller('transferFrameCtrl', ['$scope' ,'ossUploadManager','ossDownloadManager','Toast',
function($scope ,ossUploadManager,ossDownloadManager, Toast){

   angular.extend($scope, {
     lists: {
       uploadJobList: [],
       downloadJobList: [],
     },

     totalProg: {loaded:0,total:0},
     totalNum: {running:0,total:0,  upDone: 0, downDone: 0},
     calcTotalProg: calcTotalProg,

     transTab: 1,

   });


   //functions in parent scope
   $scope.handlers.uploadFilesHandler = uploadFilesHandler;

   $scope.handlers.downloadFilesHandler = downloadFilesHandler;


   $scope.netInit().then(function(){
     //确认是否可以使用内部网络，再初始化
     ossUploadManager.init($scope);
     ossDownloadManager.init($scope);
   });


   /**
    * 下载
    * @param fromOssPath {array}  item={region, bucket, path, name, size=0, isFolder=false}  有可能是目录，需要遍历
    * @param toLocalPath {string}
    */
   function downloadFilesHandler(fromOssPath, toLocalPath) {
     Toast.info('正在添加到下载队列');
     ossDownloadManager.createDownloadJobs(fromOssPath, toLocalPath, function(){
       $scope.toggleTransVisible(true);
       $scope.transTab = 2;
       Toast.info('已全部添加到下载队列');
     });
   }
   /**
    * 上传
    * @param filePaths []  {array<string>}  有可能是目录，需要遍历
    * @param bucketInfo {object} {bucket, region, key}
    */
   function uploadFilesHandler(filePaths, bucketInfo) {
      Toast.info('正在添加到上传队列');
      ossUploadManager.createUploadJobs(filePaths, bucketInfo, function(){
        Toast.info('已全部添加到下载队列');
        $scope.toggleTransVisible(true);
        $scope.transTab = 1;
      });

   }





   function calcTotalProg(){
       var c=0, c2=0;
       angular.forEach($scope.lists.uploadJobList,function(n){
         if(n.status=='running' || n.status=='waiting' || n.status=='stopped'){
           c++;
         }
       });
       angular.forEach($scope.lists.downloadJobList,function(n){
         if(n.status=='running' || n.status=='waiting' || n.status=='stopped'){
           c2++;
         }
       });
      //  $scope.totalNum.upRunning = c;
      //  $scope.totalNum.downRunning = c;
       $scope.totalNum.running=c + c2;

       $scope.totalNum.upDone = $scope.lists.uploadJobList.length-c;
       $scope.totalNum.downDone = $scope.lists.downloadJobList.length-c2;

       $scope.totalNum.total = $scope.lists.uploadJobList.length + $scope.lists.downloadJobList.length;
     }

}]);