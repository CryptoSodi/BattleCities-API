declare const require: any;
import { createJsonResponse, createOptionsResponse } from '../_helpers';
import { isResponse, requireAdmin, storeErrorResponse } from './_helpers';
const tasks=require('../../stores/xCommentTaskStore');
export function OPTIONS(request:Request){return createOptionsResponse(request);}
export async function GET(request:Request):Promise<Response>{const auth=await requireAdmin(request);if(isResponse(auth))return auth;return createJsonResponse(request,{ok:true,items:await tasks.list()});}
export async function POST(request:Request):Promise<Response>{const auth=await requireAdmin(request);if(isResponse(auth))return auth;try{const body=await request.json();return createJsonResponse(request,{ok:true,task:await tasks.create(auth.player.id,body.post)},201);}catch(error){return storeErrorResponse(request,error)||createJsonResponse(request,{ok:false,error:(error as Error).message},400);}}
