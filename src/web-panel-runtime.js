let page=null;function setPage(p){page=p}function getPage(){return !page||page.isClosed?.()?null:page}module.exports={setPage,getPage};
