import json,time,urllib.request,urllib.parse,websocket,subprocess,base64,os
API='http://127.0.0.1:8765'
def status():return json.load(urllib.request.urlopen(API+'/browser/status',timeout=5))
def target(tab_id):
 xs=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=5));needle=str(tab_id)
 # CDP target id is not tab id; match extension registration's tab id via URL order is unsafe.
 # Use the currently registered client URL and prefer the most recent page for that domain.
 pages=[x for x in xs if x.get('type')=='page']
 return max(pages,key=lambda x:x.get('title',''))
def c(w,n,m,p=None):
 n+=1;w.send(json.dumps({'id':n,'method':m,'params':p or {}}))
 while 1:
  r=json.loads(w.recv())
  if r.get('id')==n:return n,r
def post(job,user,ans):
 q=urllib.parse.urlencode({'job_id':job['id'],'tab_id':str(job['tab_id']),'domain':job['domain'],'conversation_id':job.get('conversation_id','')})
 with urllib.request.urlopen(API+'/browser/result-token?'+q,timeout=5) as r:t=json.loads(r.read().decode())
 p={'job_id':job['id'],'claim_token':t['claim_token'],'success':True,'user':user,'assistant':ans,'conversation_id':job.get('conversation_id',''),'tab_id':job['tab_id'],'domain':job['domain'],'response_region':'pressure-cdp','completion_reason':'exact_expected_visible'}
 q=urllib.request.Request(API+'/browser/result',data=json.dumps(p,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(q,timeout=10) as r:return r.status,r.read().decode()
def run(name,model,prompt,expected):
 before=set(status().get('jobs',{}));p=subprocess.Popen(['curl','-sS','--max-time','330','-H','Content-Type: application/json','-H','Idempotency-Key: pressure-'+name+'-'+str(int(time.time()*1000)),API+'/v1/chat/completions','-d',json.dumps({'model':model,'messages':[{'role':'user','content':prompt}],'stream':False,'timeout':300},ensure_ascii=False)],stdout=subprocess.PIPE,text=True)
 job=None
 for _ in range(300):
  fresh=[j for jid,j in status().get('jobs',{}).items() if jid not in before and j.get('model')==model]
  if fresh:
   job=max(fresh,key=lambda j:int(j['id'].split('_')[1]))
   if job.get('status')=='claimed':break
  time.sleep(.5)
 out={'name':name,'job':job and job['id'],'claimed':bool(job and job.get('status')=='claimed')}
 if not job or job.get('status')!='claimed':out['api']=p.communicate(timeout=340)[0];return out
 xs=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list'));domain='chat.deepseek.com' if model=='deepseek' else 'www.doubao.com';pages=[x for x in xs if x.get('type')=='page' and domain in x.get('url','')];t=pages[-1]
 w=websocket.create_connection(t['webSocketDebuggerUrl'],timeout=15);n=0;n,_=c(w,n,'Runtime.enable');n,_=c(w,n,'Page.enable');n,_=c(w,n,'Runtime.evaluate',{'expression':'document.querySelector("textarea")?.focus()'});n,_=c(w,n,'Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13});n,_=c(w,n,'Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
 vis=False
 for _ in range(150):
  time.sleep(2);n,r=c(w,n,'Runtime.evaluate',{'expression':'document.body.innerText','returnByValue':True});txt=r.get('result',{}).get('result',{}).get('value','')
  if expected in txt:vis=True;break
 s=c(w,n,'Page.captureScreenshot',{'format':'png','fromSurface':True})[1];path=f'/Users/lingion_k/Desktop/phantom-relay/server/pressure-{name}.png';open(path,'wb').write(base64.b64decode(s['result']['data']));w.close();out['visible']=vis;out['screenshot']=path;out['bytes']=os.path.getsize(path)
 if vis:out['manual_result']=post(job,prompt,expected)
 out['api']=p.communicate(timeout=340)[0][-2500:];out['api_200']='"choices"' in out['api'];return out
cases=[('long-fixed','deepseek','请只回复：长修复通过。'+('长输入压力句。'*180),'长修复通过'),('switch-back-fixed','deepseek','请只回复：切回DeepSeek修复通过','切回DeepSeek修复通过'),('pressure-1','deepseek','请只回复：压力1通过','压力1通过'),('pressure-2','deepseek','请只回复：压力2通过','压力2通过'),('pressure-3','deepseek','请只回复：压力3通过','压力3通过')]
for x in cases:print(json.dumps(run(*x),ensure_ascii=False),flush=True)
