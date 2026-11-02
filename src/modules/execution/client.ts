import {DomainError} from '../../contracts/index.ts';
import type {ExecutionClient,ExecutionRecord} from '../../contracts/execution.ts';
export function createExecutionClient({baseUrl='',teamId,csrfToken,fetch:request=globalThis.fetch,onForbidden}:{baseUrl?:string;teamId:string;csrfToken:string;fetch?:typeof fetch;onForbidden?:()=>void}):ExecutionClient {
 const abort=new AbortController();let disposed=false;
 const call=async<T>(method:string,input:unknown):Promise<T>=>{
  if(disposed)throw new DomainError('FORBIDDEN','工作区已关闭');
  const response=await request(`${baseUrl}/api/execution/${method}`,{method:'POST',credentials:'same-origin',signal:abort.signal,headers:{'Content-Type':'application/json','X-Team-Id':teamId,'X-CSRF-Token':csrfToken},body:JSON.stringify(input)});
  if(disposed)throw new DomainError('FORBIDDEN','工作区已关闭');
  if(response.status===401||response.status===403){disposed=true;abort.abort();onForbidden?.();throw new DomainError('FORBIDDEN','登录或团队权限已失效');}
  const body=await response.json();
  if(disposed)throw new DomainError('FORBIDDEN','工作区已关闭');
  if(!response.ok||body.error)throw new DomainError(body.error?.code??'UNAVAILABLE',body.error?.message??'执行服务暂时不可用');
  return body.data as T;
 };
 return {accept:input=>call<ExecutionRecord>('accept',input),get:executionId=>call('get',{executionId}),list:()=>call('list',{}),retry:input=>call('retry',input),cancel:executionId=>call('cancel',{executionId}),dispose(){disposed=true;abort.abort();}};
}
