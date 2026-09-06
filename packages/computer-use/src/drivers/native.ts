import { execFile } from 'node:child_process';
import { access, mkdir, rmdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerUseError, type Driver, type Action, type Probe } from '../contracts.js';
import { actionSchema } from '../validation.js';

export interface NativeDesktopDriverOptions {
 /** Both explicit enable and a configured DISPLAY are required. Never selects ambient DISPLAY. */
 enabled?: boolean;
 display?: string;
 acknowledgeFullDesktopAccess?: boolean;
 /** X11 cannot enforce these restrictions through pixels; anything except all allow is incompatible. */
 permissions?: {webAccess:'allow'|'ask'|'deny';fileRead:'allow'|'ask'|'deny';fileWrite:'allow'|'ask'|'deny';codeExecution:'allow'|'ask'|'deny'};
 /** Replace with a qualified OS helper. It must enforce the same cancellation/input-release contract. */
 driver?: Driver;
}
const keys:Record<string,string>={Control:'ctrl',Alt:'alt',Shift:'shift',Meta:'super',Enter:'Return',Escape:'Escape',Backspace:'BackSpace',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',PageUp:'Prior',PageDown:'Next',Space:'space'};
/** Fixed executables and argument vectors; no shell, eval, app launcher, clipboard or file transfer. */
export function createNativeDesktopDriver(options:NativeDesktopDriverOptions={}):Driver {
 const config={...options,permissions:options.permissions?{...options.permissions}:undefined};
 const display=config.display;
 const compatible=()=>config.enabled===true&&config.acknowledgeFullDesktopAccess===true&&config.permissions&&['webAccess','fileRead','fileWrite','codeExecution'].every(k=>config.permissions![k as keyof NonNullable<typeof config.permissions>]==='allow');
 if(config.driver && (config.driver.kind!=='native-desktop'||!config.driver.lockDomain))throw new ComputerUseError('invalid_request','Native helpers require native kind and shared input lockDomain');
 const delegate=config.driver;
 const domain=delegate?.lockDomain??`native-x11:${userInfo().uid}:${display?.replace(/\.\d+$/,'')??'unconfigured'}`;
 const env={...process.env,DISPLAY:display??''};
 const run=(binary:'/usr/bin/xdotool'|'/usr/bin/import',args:string[],signal?:AbortSignal):Promise<Buffer>=>new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new ComputerUseError('cancelled'));return;}
  execFile(binary,args,{env,encoding:'buffer',timeout:5000,maxBuffer:9*1024*1024,signal,killSignal:'SIGKILL'},(error,stdout)=>{if(error)reject(new ComputerUseError(signal?.aborted?'cancelled':'driver_error','X11 command failed'));else resolve(stdout);});
 });
 const probe=async():Promise<Probe>=>{
  const no=(reason:string):Probe=>({available:false,kind:'native-desktop',reason,capabilities:[]});
  if(!compatible())return no('Native target needs explicit enable, full-desktop acknowledgement, and all file/network/code permissions allowed; X11 cannot confine applications');
  if(delegate){try{return await delegate.probe();}catch{return no('Configured native helper unavailable');}}
  if(platform()!=='linux')return no('No native driver installed for this OS; supply a qualified native-desktop driver');
  if(!display)return no('No configured DISPLAY (headless hosts are unsupported)');
  if(!/^:[0-9]+(?:\.[0-9]+)?$/.test(display))return no('Only explicitly configured local X11 DISPLAY values are supported');
  if(process.env.WAYLAND_DISPLAY)return no('Wayland/XWayland full desktop capture is not qualified; supply a Wayland driver');
  try{await access('/usr/bin/xdotool',constants.X_OK);await access('/usr/bin/import',constants.X_OK);await run('/usr/bin/xdotool',['getdisplaygeometry']);}
  catch{return no('Requires reachable local X11, /usr/bin/xdotool (libxdo/XTEST), and ImageMagick /usr/bin/import; nothing is installed automatically');}
  return {available:true,kind:'native-desktop',capabilities:['screenshot','pointer','keyboard'],reason:'X11 prerequisites detected; live app workflows remain operator-qualified'};
 };
 return {kind:'native-desktop',lockDomain:domain,probe,async open(context){
  context.signal.throwIfAborted();const capability=await probe();if(!capability.available)throw new ComputerUseError('unsupported',capability.reason);context.signal.throwIfAborted();
  if(delegate)return delegate.open(context);
  // Cross-process lock: fail closed on a stale/crashed holder; never guess that it is safe to steal input.
  const root=join(tmpdir(),`computer-use-x11-${userInfo().uid}`);await mkdir(root,{mode:0o700,recursive:true});const st=await lstat(root);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==userInfo().uid||(st.mode&0o077)!==0)throw new ComputerUseError('denied','Unsafe native lock directory');
  const lock=join(root,createHash('sha256').update(domain).digest('hex'));try{await mkdir(lock,{mode:0o700});}catch{throw new ComputerUseError('lease_conflict','Native input locked; stale locks require operator inspection');}
  let closed=false;const heldButtons=new Set<string>(),heldKeys=new Set<string>();
  const input=(args:string[],sig?:AbortSignal)=>{if(closed)throw new ComputerUseError('stopped');return run('/usr/bin/xdotool',args,sig);};
  const releaseInput=async()=>{for(const b of [...heldButtons]){await input(['mouseup',b]);heldButtons.delete(b);}for(const k of [...heldKeys].reverse()){await input(['keyup',k]);heldKeys.delete(k);}};
  return {releaseInput,async close(){if(closed)return;await releaseInput();closed=true;await rmdir(lock);},async observe(sig){sig.throwIfAborted();if(closed)throw new ComputerUseError('stopped');const png=await run('/usr/bin/import',['-window','root','png:-'],sig);sig.throwIfAborted();if(png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new ComputerUseError('driver_error','Invalid PNG capture');return {data:png.toString('base64'),mimeType:'image/png',width:png.readUInt32BE(16),height:png.readUInt32BE(20),capturedAt:Date.now()};},async act(raw:Action,sig){const a=actionSchema.parse(raw);sig.throwIfAborted();try{
   switch(a.type){
    case 'move':await input(['mousemove',String(a.x),String(a.y)],sig);break;
    case 'click':await input(['mousemove',String(a.x),String(a.y)],sig);sig.throwIfAborted();{const b=String({left:1,middle:2,right:3}[a.button??'left']);heldButtons.add(b);await input(['mousedown',b],sig);sig.throwIfAborted();await input(['mouseup',b],sig);heldButtons.delete(b);}break;
    case 'drag':await input(['mousemove',String(a.x),String(a.y)],sig);sig.throwIfAborted();heldButtons.add('1');await input(['mousedown','1'],sig);for(let i=1;i<=10;i++){await delay((a.durationMs??200)/10,undefined,{signal:sig});await input(['mousemove',String(Math.round(a.x+(a.toX-a.x)*i/10)),String(Math.round(a.y+(a.toY-a.y)*i/10))],sig);}await input(['mouseup','1'],sig);heldButtons.delete('1');break;
    case 'scroll':for(const [delta,negative,positive] of [[a.deltaY,'4','5'],[a.deltaX,'6','7']] as const){for(let i=0;i<Math.ceil(Math.abs(delta)/100);i++){sig.throwIfAborted();await input(['click',delta<0?negative:positive],sig);}}break;
    case 'type':for(const character of a.text){sig.throwIfAborted();const k=character==='\n'?'Return':character==='\t'?'Tab':`U${character.codePointAt(0)!.toString(16).padStart(4,'0')}`;heldKeys.add(k);await input(['keydown',k],sig);await input(['keyup',k],sig);heldKeys.delete(k);}break;
    case 'key':for(const key of a.key.split('+')){const k=keys[key]??key;sig.throwIfAborted();heldKeys.add(k);await input(['keydown',k],sig);}break;
    case 'wait':await delay(a.durationMs,undefined,{signal:sig});break;
    case 'navigate':throw new ComputerUseError('unsupported','Navigation belongs to browser targets, not native desktop');
   }
  }finally{await releaseInput();}}};
 }};
}
