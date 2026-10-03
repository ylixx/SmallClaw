async function main(){
  process.env.LOCALCLAW_DISABLE_SERVER='1';
  console.log('before import');
  await import('../src/gateway/server');
  console.log('after import');
}
main().then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1);});
