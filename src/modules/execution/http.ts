import type {IncomingMessage,ServerResponse} from 'node:http';
import {DomainError,type Actor} from '../../contracts/index.ts';
import type {ExecutionService} from '../../contracts/execution.ts';
export type ExecutionOperation='accept'|'get'|'list'|'retry'|'cancel';
export function createExecutionHttpHandler({execution,identity,beforeRequest}:{
 execution:ExecutionService;identity:{resolveActor(req:IncomingMessage):Promise<Actor>;assertCsrf(req:IncomingMessage):Promise<void>};
 beforeRequest?:(context:{req:IncomingMessage;actor:Actor;operation:ExecutionOperation})=>void|Promise<void>;
}) {
 return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
  const path=new URL(req.url??'/','http://execution.invalid').pathname;
  if(!path.startsWith('/api/execution/'))return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const json=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
  try{
   const operation=path.slice('/api/execution/'.length) as ExecutionOperation;
   if(req.method!=='POST'||!['accept','get','list','retry','cancel'].includes(operation))throw new DomainError('NOT_FOUND','接口不存在');
   await identity.assertCsrf(req);const actor=await identity.resolveActor(req);
   await beforeRequest?.({req,actor,operation});
   if(!req.headers['content-type']?.startsWith('application/json'))throw new DomainError('VALIDATION','请求必须使用 JSON');
   let size=0;const chunks:Buffer[]=[];
   for await(const chunk of req){size+=chunk.length;if(size>32768)throw new DomainError('VALIDATION','任务内容过大');chunks.push(Buffer.from(chunk));}
   let input:any;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DomainError('VALIDATION','请求内容无效');}
   if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError('VALIDATION','请求内容无效');
   const keys:Record<ExecutionOperation,string[]>={accept:['prompt','skillIds','idempotencyKey','sessionId','parentTaskId'],get:['executionId'],list:[],retry:['executionId','idempotencyKey','acknowledgeUncertain'],cancel:['executionId']};
   if(Object.keys(input).some(key=>!keys[operation].includes(key)))throw new DomainError('VALIDATION','请求包含不支持的字段');
   const result=operation==='list'?await execution.list(actor):operation==='get'||operation==='cancel'?await execution[operation](actor,input.executionId):operation==='accept'?await execution.accept(actor,input):await execution.retry(actor,input);
   json(200,{data:result});
  }catch(error){const known=error instanceof DomainError;const code=known?error.code:'UNAVAILABLE';json(code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:code==='VALIDATION'?400:code==='CONFLICT'?409:503,{error:{code,message:known?error.message:'执行服务暂时不可用'}});}
  return true;
 };
}
