#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ComputerUseService } from './service.js';
import { createMcpServer } from './mcp.js';
import type { Principal, ServiceOptions } from './contracts.js';

/** Config is trusted operator code, not an MCP input or model-accessible file picker. */
async function main(){
 const args=process.argv.slice(2);
 if(args.length!==0 && !(args.length===2&&args[0]==='--config'))throw new Error('usage');
 let options:ServiceOptions={},principal:Principal={ownerId:'standalone',actorId:'stdio',role:'agent'};
 if(args[1]){const config=await import(pathToFileURL(resolve(args[1])).href);options=config.options??{};principal=config.principal??principal;}
 const service=new ComputerUseService(options),server=createMcpServer(service,principal);
 let stopping=false;
 const shutdown=async()=>{if(stopping)return;stopping=true;const timer=setTimeout(()=>process.exit(1),5000);timer.unref();try{await service.dispose();await server.close();}finally{clearTimeout(timer);}};
 process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});process.stdin.once('end',()=>{void shutdown();});
 await server.connect(new StdioServerTransport());
}
main().catch(()=>{process.stderr.write('computer-use-mcp: startup failed (check trusted configuration and prerequisites)\n');process.exitCode=1;});
