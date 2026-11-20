declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
const economy = require('../../stores/economyStore');
const players = require('../../stores/playerStore');
const identity = require('../../services/sessionIdentity');
const sessions = require('../../stores/sessionStore');
export function OPTIONS(request: Request): Response { return createOptionsResponse(request); }
export async function POST(request: Request): Promise<Response> {
  const id=identity.resolveSession(request.headers.get('cookie')||'');
  const session=id?await sessions.readSession(id):null;
  const player=session?.playerId?await players.readPlayerForSession(session):null;
  if(!player)return createJsonResponse(request,{ok:false,statusText:'NOT LOGGED IN'},401);
  let body:any;try{body=await request.json();}catch{return createJsonResponse(request,{ok:false,statusText:'INVALID JSON'},400);}
  const result=await economy.refundMultiplayerPowerup(player,body?.itemId,body?.requestId,body?.matchId);
  return createJsonResponse(request,result,result.ok?200:409);
}
