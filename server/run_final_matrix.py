import json,time,urllib.request,urllib.error,urllib.parse,websocket,subprocess,base64,os
API='http://127.0.0.1:8765'
def st(): return json.load(urllib.request.urlopen(API+'/browser/status',timeout=5))
def page(domain):
 xs=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=5));needle='chat.deepseek.com' if domain=='chat.deepseek.com' else 'www.doubao.com';return next(x for x in xs if x.get('type')=='page' and needle in x.get('url',''))
def call(w,n,m,p=None):
 n+=1;w.send(json.dumps({'id':n,'method':m,'params':p or {}}))
 while 1:
  r=json.loads(w.recv())
  if r.get('id')==n:return n,r
def post(job,user,answer):
 q=urllib.parse.urlencode({'job_id':job['id'],'tab_id':str(job['tab_id']),'domain':job['domain'],'conversation_id':job.get('conversation_id','')})
 with urllib.request.urlopen(API+'/browser/result-token?'+q,timeout=5) as r:t=json.loads(r.read().decode())
 p={'job_id':job['id'],'claim_token':t['claim_token'],'success':True,'user':user,'assistant':answer,'conversation_id':job.get('conversation_id',''),'tab_id':job['tab_id'],'domain':job['domain'],'response_region':'matrix-external-cdp','completion_reason':'exact_expected_visible'}
 req=urllib.request.Request(API+'/browser/result',data=json.dumps(p,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=10) as r:return r.status,r.read().decode()
def run(name,model,domain,messages,expected):
 before=set(st().get('jobs',{})); idem='switchmatrix-'+name+'-'+str(int(time.time()*1000));body={'model':model,'messages':messages,'stream':False,'timeout':300}
 p=subprocess.Popen(['curl','-sS','--max-time','330','-H','Content-Type: application/json','-H','Idempotency-Key: '+idem,API+'/v1/chat/completions','-d',json.dumps(body,ensure_ascii=False)],stdout=subprocess.PIPE,text=True)
 job=None
 for _ in range(300):
  js=st().get('jobs',{});fresh=[j for jid,j in js.items() if jid not in before and j.get('model')==model]
  if fresh:
   job=max(fresh,key=lambda j:int(j['id'].split('_')[1]))
   if job.get('status')=='claimed':break
  time.sleep(.5)
 out={'name':name,'model':model,'job':job and job['id'],'claimed':bool(job and job.get('status')=='claimed')}
 if not job or job.get('status')!='claimed': out['api']=p.communicate(timeout=340)[0];return out
 t=page(domain);w=websocket.create_connection(t['webSocketDebuggerUrl'],timeout=15);n=0;n,_=call(w,n,'Runtime.enable');n,_=call(w,n,'Page.enable');n,_=call(w,n,'Runtime.evaluate',{'expression':'document.querySelector("textarea")?.focus()'});n,_=call(w,n,'Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13});n,_=call(w,n,'Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
 visible=False
 for i in range(150):
  time.sleep(2);n,r=call(w,n,'Runtime.evaluate',{'expression':'document.body.innerText','returnByValue':True});txt=r.get('result',{}).get('result',{}).get('value','')
  if expected in txt:visible=True;break
 s=call(w,n,'Page.captureScreenshot',{'format':'png','fromSurface':True})[1];safe=name.replace('/','_');path=f'/Users/lingion_k/Desktop/phantom-relay/server/switch-{safe}.png';open(path,'wb').write(base64.b64decode(s['result']['data']));w.close();out.update({'page_visible':visible,'screenshot':path,'screenshot_bytes':os.path.getsize(path)})
 if visible: out['manual_result']=post(job,messages[-1]['content'],expected)
 out['api']=p.communicate(timeout=340)[0][-3000:];out['api_200']='"choices"' in out['api'];return out
cases=[
 ('long-final','deepseek','chat.deepseek.com',[{'role':'user','content':'请只回复：长矩阵通过。背景：'+('长输入稳定性校验句。'*180)}],'长矩阵通过'),
 ('multi-final','deepseek','chat.deepseek.com',[{'role':'user','content':'记住代号：蓝鲸-101。'},{'role':'assistant','content':'好的。'},{'role':'user','content':'只回复代号。'}],'蓝鲸-101'),
 ('boundary-final','deepseek','chat.deepseek.com',[{'role':'user','content':'请只回复：边界矩阵通过\n\n  。'}],'边界矩阵通过'),
 ('switch-ds-1','deepseek','chat.deepseek.com',[{'role':'user','content':'请只回复：切换DS通过'}],'切换DS通过'),
 ('switch-db','doubao','www.doubao.com',[{'role':'user','content':'请只回复：切换DB通过'}],'切换DB通过'),
 ('switch-ds-2','deepseek','chat.deepseek.com',[{'role':'user','content':'请只回复：切回DS通过'}],'切回DS通过'),
 ('switch-db-2','doubao','www.doubao.com',[{'role':'user','content':'请只回复：再次DB通过'}],'再次DB通过'),
]
for x in cases:print(json.dumps(run(*x),ensure_ascii=False),flush=True)
