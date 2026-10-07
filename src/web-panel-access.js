const crypto=require('crypto');const {store,getRaw}=require('./config');const SIX=21600000;
const rnd=n=>crypto.randomBytes(n).toString('base64url');
function getAccess(force=false){const c=getRaw().webPanel||{},now=Date.now();if(!force&&c.user&&c.pass&&c.path&&c.auth&&now-Number(c.rotatedAt||0)<SIX)return c;const n={...c,enabled:c.enabled!==false,user:rnd(8),pass:rnd(18),path:rnd(16),auth:rnd(20),rotatedAt:now,generation:Number(c.generation||0)+1};store.setPath(['webPanel'],n);return n}
function setEnabled(v){const c=getAccess();store.setPath(['webPanel'],{...c,enabled:!!v});return getRaw().webPanel}
function url(c=getAccess()){const d=String(c.domain||'').replace(/^https?:\/\//,'').replace(/\/$/,'');return d?'https://'+d+'/'+c.path+'/'+c.auth:''}
function resetLogin(){return getAccess(true)}
function resetProfile(){const c=getRaw().webPanel||{};const n={enabled:false,domain:'',port:c.port||0,ipinfoToken:c.ipinfoToken||'',user:'',pass:'',path:'',auth:'',rotatedAt:0,generation:Number(c.generation||0)+1};store.setPath(['webPanel'],n);return n}
module.exports={getAccess,setEnabled,url,resetLogin,resetProfile,SIX};
