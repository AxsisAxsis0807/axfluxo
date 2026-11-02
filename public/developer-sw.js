/* Deliberately no fetch handler or Cache API: private APIs/media/signed URLs never persist here. */
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();});
self.addEventListener('push',event=>{
 let data;try{data=event.data.json();}catch{return;}
 if(!/^[a-f0-9-]{36}$/.test(data.batchId)||!['completed','partial_failed','failed'].includes(data.kind))return;
 event.waitUntil(self.registration.showNotification(data.kind==='completed'?'動画の書き出しが完了しました':data.kind==='partial_failed'?'一部の動画の書き出しに失敗しました':'動画の書き出しに失敗しました',{body:'開発者Studioで結果を確認してください。',tag:String(data.tag).slice(0,160),data:{batchId:data.batchId}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const target=new URL('studio/',self.registration.scope);
 event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{const found=windows.find(w=>w.url.startsWith(target.href));if(found)return found.focus();return clients.openWindow(target.href);}));
});
