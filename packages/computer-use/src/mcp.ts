import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ComputerUseError, type Principal } from './contracts.js';
import { ComputerUseService } from './service.js';
import { actionSchema, leaseShape, refShape } from './validation.js';

export interface ToolDefinition {
 name:string;description:string;inputSchema:z.ZodRawShape;
 handler:(input:unknown,context?:{signal?:AbortSignal})=>Promise<CallToolResult>;
}
/** Canonical manifest used by both embedded adapters and real MCP. No identity/grant inputs. */
export function getToolDefinitions(service:ComputerUseService,principal:Principal):ToolDefinition[] {
 const p=Object.freeze({...principal});
 const define=<T extends z.ZodRawShape>(name:string,description:string,inputSchema:T,fn:(input:z.infer<z.ZodObject<T>>,signal?:AbortSignal)=>Promise<unknown>|unknown):ToolDefinition=>({name,description,inputSchema,async handler(raw,context){
  try{
   const result=await fn(z.object(inputSchema).strict().parse(raw),context?.signal);
   if(context?.signal?.aborted)throw new ComputerUseError('cancelled');
   if(result&&typeof result==='object'&&'frame' in result){const {frame,...metadata}=result as import('./contracts.js').Observation;return {content:[{type:'text',text:JSON.stringify({...metadata,frame:{width:frame.width,height:frame.height,capturedAt:frame.capturedAt,url:frame.url}})},{type:'image',data:frame.data,mimeType:frame.mimeType}]};}
   return {content:[{type:'text',text:JSON.stringify(result)}]};
  }catch(error){const code=error instanceof ComputerUseError?error.code:error instanceof z.ZodError?'invalid_request':'driver_error';return {isError:true,content:[{type:'text',text:JSON.stringify({error:code})}]};}
 }});
 return [
  define('computer_status','Redacted owner-scoped session status (no screenshots or leases).',{sessionId:z.string().uuid().optional()},input=>service.status(p,input.sessionId)),
  define('computer_probe','Check an explicitly configured target; never installs or launches applications.',{targetId:z.string().min(1).max(256)},input=>service.probe(p,input.targetId)),
  define('computer_open','Open an enabled authorized target and acquire exclusive control. Observe before input.',{targetId:z.string().min(1).max(256)},(input,sig)=>service.open(p,input.targetId,sig)),
  define('computer_observe','Obtain an authorized fresh screenshot from an owner session.',refShape,(input,sig)=>service.observe(p,input,sig)),
  define('computer_act','One bounded input action using the current generation and exclusive lease; no shell/eval.',{...leaseShape,actionId:z.string().min(1).max(128),action:actionSchema},(input,sig)=>service.act(p,input,sig)),
  define('computer_stop','Immediately fence session input/capture and detach. Native applications remain open.',{sessionId:z.string().uuid()},input=>service.stop(p,input.sessionId)),
  define('computer_revoke','Irreversibly revoke this session; no cached or future screenshots.',{sessionId:z.string().uuid()},input=>service.revoke(p,input.sessionId)),
 ];
}
export function createMcpServer(service:ComputerUseService,principal:Principal):McpServer {
 const server=new McpServer({name:'@wolpertingerlabs/computer-use',version:'0.1.0'});
 // Erase heterogeneous Zod shape inference at the SDK boundary; handlers still
 // validate every input against their concrete canonical schema.
 const registrar=server as unknown as {registerTool(name:string,config:{description:string;inputSchema:unknown},handler:(args:unknown,extra:{signal:AbortSignal})=>Promise<CallToolResult>):void};
 for(const tool of getToolDefinitions(service,principal))registrar.registerTool(tool.name,{description:tool.description,inputSchema:z.object(tool.inputSchema).strict()},(args,extra)=>tool.handler(args,{signal:extra.signal}));
 return server;
}
