export const MAX_PLUGIN_CATALOG_BYTES = 32 * 1024 * 1024;
export const PLUGIN_CATALOG_TIMEOUT_SECONDS = 30;

/** Read the CLI's verbose catalog with independent time/size bounds; transport IDs only. */
export function buildPluginObservationProgram(
  compactLimit: number,
  timeoutSeconds = PLUGIN_CATALOG_TIMEOUT_SECONDS,
): string {
  return String.raw`import base64,json,os,re,selectors,signal,subprocess,sys,time
raw_limit=${MAX_PLUGIN_CATALOG_BYTES}
compact_limit=${compactLimit}
deadline=time.monotonic()+${timeoutSeconds}
def cancelled(signum,frame): raise SystemExit(48)
for signum in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]: signal.signal(signum,cancelled)
child=subprocess.Popen([sys.argv[1],'plugin','list','--available','--json'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
selector=selectors.DefaultSelector()
selector.register(child.stdout,selectors.EVENT_READ)
data=bytearray()
try:
 while selector.get_map():
  remaining=deadline-time.monotonic()
  if remaining<=0: raise SystemExit(48)
  if not selector.select(remaining): raise SystemExit(48)
  chunk=os.read(child.stdout.fileno(),min(65536,raw_limit-len(data)+1))
  if not chunk:
   selector.unregister(child.stdout)
   break
  data.extend(chunk)
  if len(data)>raw_limit: raise SystemExit(47)
 try: code=child.wait(timeout=max(0,deadline-time.monotonic()))
 except subprocess.TimeoutExpired: raise SystemExit(48)
finally:
 selector.close()
 child.stdout.close()
 # Also stop descendants retaining stdout after their parent has exited.
 try: os.killpg(child.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 child.wait()
if code!=0:
 print('PLUGINS\tfailed')
 raise SystemExit(0)
try:
 parsed=json.loads(data)
 if not isinstance(parsed,dict) or not all(field in parsed for field in ['installed','available']): raise ValueError()
 compact={}
 for field in ['installed','available']:
  items=parsed[field]
  if not isinstance(items,list): raise ValueError()
  ids=[]
  for item in items:
   if not isinstance(item,dict): raise ValueError()
   value=item.get('pluginId')
   if not isinstance(value,str) or len(value.encode('utf-8'))>512 or re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9._+-]+',value) is None: raise ValueError()
   ids.append(value)
  compact[field]=[{'pluginId':value} for value in sorted(set(ids))]
 output=json.dumps(compact,separators=(',',':')).encode('utf-8')
except (ValueError,TypeError,UnicodeError,RecursionError):
 raise SystemExit(49)
if len(output)>compact_limit: raise SystemExit(45)
print('PLUGINS\tok\t'+base64.b64encode(output).decode('ascii'))`;
}
