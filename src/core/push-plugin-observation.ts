export const MAX_PLUGIN_CATALOG_BYTES = 32 * 1024 * 1024;
export const PLUGIN_CATALOG_TIMEOUT_SECONDS = 30;

export interface PluginObservationScope {
  readonly marketplaceNames: readonly string[];
  readonly pluginIds: readonly string[];
}

/** Read the CLI's verbose catalog with independent time/size bounds; transport IDs only. */
export function buildPluginObservationProgram(
  compactLimit: number,
  timeoutSeconds = PLUGIN_CATALOG_TIMEOUT_SECONDS,
  scope?: PluginObservationScope,
): string {
  return String.raw`import base64,json,os,re,selectors,signal,subprocess,sys,time
raw_limit=${MAX_PLUGIN_CATALOG_BYTES}
compact_limit=${compactLimit}
deadline=time.monotonic()+${timeoutSeconds}
def cancelled(signum,frame): raise SystemExit(48)
for signum in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]: signal.signal(signum,cancelled)
scope=json.loads(${JSON.stringify(JSON.stringify(scope ?? null))})
def read_cli(args):
 global raw_limit
 child=subprocess.Popen([sys.argv[1],*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
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
  try: os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  child.wait()
 if code!=0:
  print('PLUGINS\tfailed')
  raise SystemExit(0)
 raw_limit-=len(data)
 try: return json.loads(data)
 except (ValueError,TypeError,UnicodeError,RecursionError): raise SystemExit(49)
compact={'installed':set(),'available':set()}
def read_plugins(market=None):
 args=['plugin','list','--available','--json']
 if market is not None: args+=['--marketplace',market]
 parsed=read_cli(args)
 if not isinstance(parsed,dict) or not all(field in parsed for field in compact): raise ValueError()
 for field in compact:
  items=parsed[field]
  if not isinstance(items,list): raise ValueError()
  for item in items:
   if not isinstance(item,dict): raise ValueError()
   value=item.get('pluginId')
   if not isinstance(value,str) or len(value.encode('utf-8'))>512 or re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9._+-]+',value) is None: raise ValueError()
   compact[field].add(value)
try:
 if scope is None: read_plugins()
 else:
  # Local runtime registrations must remain observable when preserving target config.
  registered=read_cli(['plugin','marketplace','list','--json'])
  if not isinstance(registered,dict) or not isinstance(registered.get('marketplaces'),list): raise ValueError()
  markets=set(scope['marketplaceNames'])
  for item in registered['marketplaces']:
   if not isinstance(item,dict) or not isinstance(item.get('name'),str): raise ValueError()
   if item['name'] in ['openai-bundled','openai-primary-runtime','openai-curated']: markets.add(item['name'])
  markets.update(value.rsplit('@',1)[1] for value in scope['pluginIds'])
  for market in sorted(markets): read_plugins(market)
  known=compact['installed']|compact['available']
  # Preserve curated -> remote portability, but only fetch the remote catalog
  # when the local catalog cannot resolve a requested original identity.
  if 'openai-curated-remote' not in markets and any(value.endswith('@openai-curated') and value not in known for value in scope['pluginIds']):
   read_plugins('openai-curated-remote')
 output=json.dumps({field:[{'pluginId':value} for value in sorted(values)] for field,values in compact.items()},separators=(',',':')).encode('utf-8')
except (ValueError,TypeError,UnicodeError,RecursionError,KeyError,IndexError):
 raise SystemExit(49)
if len(output)>compact_limit: raise SystemExit(45)
print('PLUGINS\tok\t'+base64.b64encode(output).decode('ascii'))`;
}
