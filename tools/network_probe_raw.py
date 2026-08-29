#!/usr/bin/env python3
import json, time, urllib.request, websocket
pages=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=5)); p=next(x for x in pages if x.get('type')=='page' and 'chat.deepseek.com' in x.get('url',''))
ws=websocket.create_connection(p['webSocketDebuggerUrl'],timeout=8); seq=[0]
def call(m,params=None):
 seq[0]+=1;i=seq[0];ws.send(json.dumps({'id':i,'method':m,'params':params or {}}))
 while 1:
  r=json.loads(ws.recv())
  if r.get('id')==i:return r
call('Network.enable');call('Runtime.evaluate',{'expression':"(()=>{const e=document.querySelector('textarea,[contenteditable=\\\"true\\\"],[role=\\\"textbox\\\"]');if(!e)return false;e.focus();return true})()"});call('Input.insertText',{'text':'请只回复：网络流原文探针'});call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13});call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13})
target=None;end=time.time()+40;ws.settimeout(1)
while time.time()<end:
 try:e=json.loads(ws.recv())
 except websocket.WebSocketTimeoutException:continue
 if e.get('method')=='Network.responseReceived' and '/chat/completion' in e['params']['response'].get('url',''): target=e['params']['requestId']
 if target and e.get('method')=='Network.loadingFinished' and e['params'].get('requestId')==target:
  body=call('Network.getResponseBody',{'requestId':target}).get('result',{}).get('body','')
  print(body)
  break
ws.close()
