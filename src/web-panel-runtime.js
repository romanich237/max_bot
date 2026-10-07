let page=null,context=null;
function setPage(p){
  // Первая вкладка принадлежит монитору. Веб-панель работает только во второй.
  if(p&&!p.isClosed?.())context=p.context();
}
async function getPage(){
  if(!context)return null;
  let pages=context.pages().filter(p=>!p.isClosed?.());
  let panel=pages[1];
  if(panel)return panel;
  const monitor=pages[0];
  panel=await context.newPage();
  try{
    const url=monitor&&!monitor.isClosed?.()?monitor.url():'https://web.max.ru/';
    await panel.goto(url&&url!=='about:blank'?url:'https://web.max.ru/',{waitUntil:'domcontentloaded',timeout:15000});
  }catch{
    try{await panel.goto('https://web.max.ru/',{waitUntil:'domcontentloaded',timeout:15000})}catch{}
  }
  return panel;
}
module.exports={setPage,getPage};