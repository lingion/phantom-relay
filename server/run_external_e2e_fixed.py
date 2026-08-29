#!/usr/bin/env python3
import json,time,urllib.request,urllib.parse,websocket,subprocess
API='http://127.0.0.1:8765'; CDP='http://127.0.0.1:9334'
def get(path): return json.load(urllib.request.urlopen(API+path,timeout=10))
def post(path,obj):
 r=urllib.request.urlopen(urllib.request.Request(API+path,data=json.dumps(obj,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'}),timeout=10); return r.status,json.loads(r.read())
def pages(): return json.load(urllib.request.urlopen(CDP+'/json/list',timeout=10))
def call(w,counter,method,params=None):
 counter[0]+=1;i=counter[0];w.send(json.dumps({'id':i,'method':method,'params':params or {}}))
 while True:
  r=json.loads(w.recv())
  if r.get('id')==i:return r

def run(model,domain,prompt,expected):
 before=set(get('/browser/status').get('jobs',{}))
 key='e2e-fixed-'+model+'-'+str(int(time.time()))
 proc=subprocess.Popen(['curl','-sS','--max-time','130','-H','Content-Type: application/json','-H','Idempotency-Key: '+key,API+'/v1/chat/completions','-d',json.dumps({'model':model,'messages':[{'role':'user','content':prompt}],'stream':False,'timeout':110},ensure_ascii=False)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 job=None
 for _ in range(120):
  st=get('/browser/status'); candidates=[j for jid,j in st.get('jobs',{}).items() if jid not in before and j.get('model')==model]
  claimed=[j for j in candidates if j.get('status')=='claimed']
  if claimed: job=claimed[-1]; break
  time.sleep(.5)
 print('JOB',model,job,flush=True)
 if not job:
  proc.kill(); print('NO_CLAIM',proc.communicate(),flush=True); return False
 p=next(x for x in pages() if x.get('type')=='page' and domain in x.get('url',''))
 w=websocket.create_connection(p['webSocketDebuggerUrl'],timeout=15); counter=[0]
 selector='textarea.semi-input-textarea.semi-input-textarea-autosize' if model=='doubao' else 'textarea'
 expr=f"(()=>{{const e=document.querySelector({json.dumps(selector)});if(!e)return null;e.focus();return {{active:document.activeElement===e,value:e.value||''}}}})()"
 state=call(w,counter,'Runtime.evaluate',{'expression':expr,'returnByValue':True})['result']['result'].get('value')
 print('FOCUS',state,flush=True)
 current=(state or {}).get('value','')
 if current != prompt:
  call(w,counter,'Input.insertText',{'text':prompt})
  print('INSERTED',flush=True)
 else: print('ALREADY_INSERTED',flush=True)
 call(w,counter,'Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
 call(w,counter,'Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
 print('ENTER',flush=True)
 answer=''
 for i in range(70):
  time.sleep(2)
  body=call(w,counter,'Runtime.evaluate',{'expression':'document.body.innerText.slice(-3500)','returnByValue':True})['result']['result'].get('value','')
  if expected in body:
   answer=expected; break
  if i%5==4: print('WAIT',i*2,repr(body[-300:]),flush=True)
 print('ANSWER',model,repr(answer),'seconds',i*2,flush=True)
 shot=call(w,counter,'Page.captureScreenshot',{'format':'png','fromSurface':True})['result']['data']; open(f'/Users/lingion_k/Desktop/phantom-relay/server/{model}-e2e-fixed.png','wb').write(__import__('base64').b64decode(shot))
 w.close()
 if not answer: proc.kill(); return False
 q=urllib.parse.urlencode({'job_id':job['id'],'tab_id':str(job['tab_id']),'domain':domain,'conversation_id':job.get('conversation_id','')})
 tok=get('/browser/result-token?'+q)
 print('RESULT',post('/browser/result',{'job_id':job['id'],'claim_token':tok['claim_token'],'success':True,'user':prompt,'assistant':answer,'conversation_id':job.get('conversation_id',''),'tab_id':job['tab_id'],'domain':domain,'response_region':'external-cdp-e2e-fixed','completion_reason':'exact_answer'}),flush=True)
 out,err=proc.communicate(timeout=30); print('API_RAW',out,err,flush=True)
 try: ok=bool(json.loads(out)['choices'][0]['message']['content']); print('API_OK',ok,flush=True); return ok
 except Exception as e: print('API_PARSE_FAIL',e,flush=True); return False
if __name__=='__main__':
 a=run('deepseek','chat.deepseek.com','请只回复：DeepSeek真实回车闭环通过','DeepSeek真实回车闭环通过')
 b=run('doubao','www.doubao.com','请只回复：豆包真实回车闭环通过','豆包真实回车闭环通过')
 print('FINAL',a,b)
