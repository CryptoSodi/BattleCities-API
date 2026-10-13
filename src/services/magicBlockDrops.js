const fs = require('node:fs');
const crypto = require('node:crypto');
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } = require('@solana/web3.js');
const policy = require('./magicBlockPolicy');
const PROGRAM = new PublicKey('8zNbfcBUVCcNkMs4rEKkPv9UsfEwemEdd2bfMerNwd52');
const VRF = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const QUEUE = new PublicKey('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh');
const TYPES = ['defence','freeze','life','shield','speed','upgrade','zoomout','wipeout'];
const discriminator = name => crypto.createHash('sha256').update(name).digest().subarray(0,8);
const bad = message => Object.assign(new Error(message), {status:400});
let cached;const pending = new Map();
function config() {
  if (process.env.BATTLECITY_ENVIRONMENT !== 'devnet' || process.env.BATTLECITY_SOLANA_NETWORK !== 'devnet' || process.env.BATTLECITY_MAGICBLOCK_ENABLED !== '1') throw new Error('Disabled');
  const secret = process.env.BATTLECITY_MAGICBLOCK_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Missing session secret');
  if (!cached) {
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.BATTLECITY_MAGICBLOCK_PAYER_FILE, 'utf8'))));
    cached = { payer, connection:new Connection('https://api.devnet.solana.com','confirmed') };
  }
  return {...cached,secret};
}
function createSession(playerId, body) {
  for (const n of [body.width,body.height]) if (!Number.isSafeInteger(n)||n<256||n>4096||n%64) throw bad('Invalid map dimensions');
  const {secret}=config();
  const session={id:crypto.randomBytes(32).toString('hex'),playerId,width:body.width,height:body.height,mode:'magicblock',expires:Date.now()+3600000};
  return {mode:'magicblock',network:'devnet',token:policy.sign(session,secret),expires:session.expires};
}
function addresses(payer,session,index) {
  const game=PublicKey.findProgramAddressSync([Buffer.from('game'),payer.toBuffer(),Buffer.from(session.id,'hex')],PROGRAM)[0];
  const number=Buffer.alloc(2);number.writeUInt16LE(index);
  const drop=PublicKey.findProgramAddressSync([Buffer.from('drop'),game.toBuffer(),number],PROGRAM)[0];
  return {game,drop};
}
function decode(info, address, game, index, session) {
  if(!info)return null;
  const b=info.data;
  if(!info.owner.equals(PROGRAM)||b.length!==84||!b.subarray(0,8).equals(discriminator('account:Drop'))||
     !b.subarray(8,40).equals(game.toBuffer())||b.readUInt16LE(40)!==index||b.readUInt16LE(42)!==session.width||b.readUInt16LE(44)!==session.height) throw new Error('Invalid drop account');
  if(b[46]===0)return {status:'pending',account:address.toBase58()};
  if(b[46]!==1||b[47]>=TYPES.length)throw new Error('Invalid outcome');
  const kind=TYPES[b[47]],x=b.readUInt16LE(48),y=b.readUInt16LE(50);
  // Recompute the published mapping as well as checking account ownership.
  const mapped=(offset,count)=>Number(BigInt(b.readUInt32LE(offset))*BigInt(count)>>32n);
  if(b[47]!==mapped(52,8)||x!==32*(1+mapped(56,session.width/32-2))||y!==32*(1+mapped(60,session.height/32-2)))throw new Error('Outcome mapping mismatch');
  return {status:'ready',value:`${kind}|${x}|${y}|${address.toBase58()}`,account:address.toBase58(),network:'devnet'};
}
async function drop(playerId,body) {
  const cfg=config();let session;
  try {session=policy.verify(body.token,cfg.secret,playerId);}catch{throw bad('Invalid, expired or foreign MagicBlock session');}
  if(!Number.isSafeInteger(body.index)||body.index<0||body.index>=64)throw bad('Invalid drop index');
  const {game,drop:address}=addresses(cfg.payer.publicKey,session,body.index);
  const key=address.toBase58();
  if(pending.has(key))return pending.get(key);
  const work=(async()=>{
    const existing=decode(await cfg.connection.getAccountInfo(address),address,game,body.index,session);
    if(existing)return existing;
    const data=Buffer.alloc(46);discriminator('global:request_drop').copy(data);Buffer.from(session.id,'hex').copy(data,8);
    data.writeUInt16LE(body.index,40);data.writeUInt16LE(session.width,42);data.writeUInt16LE(session.height,44);
    const identity=PublicKey.findProgramAddressSync([Buffer.from('identity')],PROGRAM)[0];
    const keys=[
      {pubkey:cfg.payer.publicKey,isSigner:true,isWritable:true},
      {pubkey:game,isSigner:false,isWritable:true},{pubkey:address,isSigner:false,isWritable:true},
      {pubkey:QUEUE,isSigner:false,isWritable:true},{pubkey:identity,isSigner:false,isWritable:false},
      {pubkey:VRF,isSigner:false,isWritable:false},{pubkey:SYSVAR_SLOT_HASHES_PUBKEY,isSigner:false,isWritable:false},
      {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    ];
    const transaction=new Transaction().add(new TransactionInstruction({programId:PROGRAM,keys,data}));
    const block=await cfg.connection.getLatestBlockhash();transaction.recentBlockhash=block.blockhash;transaction.feePayer=cfg.payer.publicKey;transaction.sign(cfg.payer);
    const signature=await cfg.connection.sendRawTransaction(transaction.serialize(),{skipPreflight:false,maxRetries:2});
    return {status:'pending',account:key,signature};
  })();
  pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
module.exports={createSession,drop,decode,addresses,TYPES,PROGRAM};
