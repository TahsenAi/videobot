const TG = 'https://api.telegram.org/bot';
const now = () => Math.floor(Date.now()/1000);
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST,OPTIONS'}});
async function tg(env, method, body) {
  const r = await fetch(`${TG}${env.BOT_TOKEN}/${method}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}
async function send(env, chat_id, text, reply_markup) { return tg(env,'sendMessage',{chat_id,text, ...(reply_markup?{reply_markup}:{})}); }
async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const p = new URLSearchParams(initData); const hash = p.get('hash'); if (!hash) return null; p.delete('hash');
  const entries = [...p.entries()].sort(([a],[b])=>a.localeCompare(b));
  const check = entries.map(([k,v])=>`${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw',enc.encode('WebAppData'),'HMAC',{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const secret = await crypto.subtle.sign('HMAC',secretKey,enc.encode(botToken));
  const key = await crypto.subtle.importKey('raw',secret,'HMAC',{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig = await crypto.subtle.sign('HMAC',key,enc.encode(check));
  const hex = [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if (hex !== hash) return null;
  const authDate = Number(p.get('auth_date')||0); if (!authDate || now()-authDate>86400) return null;
  try { return JSON.parse(p.get('user')||'{}'); } catch { return null; }
}
async function isAdmin(env, id) { return String(id) === String(env.ADMIN_ID); }
async function adminHelp(env, chat) {
 return send(env,chat,
 '🛠 Admin commands\n\n/addvideo Title — তারপর পরের মেসেজে ভিডিও পাঠাও\n/addtask VIDEO_ID ad Title | https://ad1.com,https://ad2.com,https://ad3.com\n/addtask VIDEO_ID channel Title | @channelusername\n/listvideos\n/listtasks VIDEO_ID\n/deletetask TASK_ID\n\nভিডিওর file_id Bot নিজে সংরক্ষণ করবে। Channel task যাচাই করতে Bot-কে ওই channel-এ Admin করতে হবে।');
}
async function onUpdate(env, update) {
 const m = update.message; if (!m) return;
 const chat = m.chat.id, uid = m.from?.id;
 if (String(uid)===String(env.ADMIN_ID)) {
   const text = m.text || '';
   if (text.startsWith('/admin')) return adminHelp(env,chat);
   if (text.startsWith('/addvideo ')) {
     const title=text.slice(10).trim(); if(!title) return send(env,chat,'ব্যবহার: /addvideo ভিডিওর নাম');
     await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind('pending_video_title',title).run();
     return send(env,chat,`এখন “${title}” ভিডিওটি এই Bot-এ পাঠাও।`);
   }
   if (m.video) {
     const pending=await env.DB.prepare("SELECT value FROM settings WHERE key='pending_video_title'").first();
     if(pending?.value){
       await env.DB.prepare('INSERT INTO videos(title,file_id,created_at) VALUES(?,?,?)').bind(pending.value,m.video.file_id,now()).run();
       await env.DB.prepare("DELETE FROM settings WHERE key='pending_video_title'").run();
       return send(env,chat,`ভিডিও যোগ হয়েছে: ${pending.value}\nএখন /listvideos দিয়ে ID দেখো, তারপর /addtask দিয়ে Task যোগ করো।`);
     }
   }
   if (text==='/listvideos') {
     const {results=[]}=await env.DB.prepare('SELECT id,title FROM videos WHERE active=1 ORDER BY id DESC').all();
     return send(env,chat,results.length?results.map(v=>`${v.id}. ${v.title}`).join('\n'):'এখনও কোনো ভিডিও নেই।');
   }
   if (text.startsWith('/listtasks ')) {
     const id=Number(text.split(/\s+/)[1]); const {results=[]}=await env.DB.prepare('SELECT id,kind,title,url FROM tasks WHERE video_id=? AND active=1').bind(id).all();
     return send(env,chat,results.length?results.map(t=>`${t.id}. [${t.kind}] ${t.title} — ${t.url}`).join('\n'):'এই ভিডিওতে Task নেই।');
   }
   if (text.startsWith('/addtask ')) {
     const rest=text.slice(9).trim(); const match=rest.match(/^(\d+)\s+(ad|channel)\s+(.+?)\s*\|\s*(.+)$/i);
     if(!match) return send(env,chat,'ব্যবহার:\n/addtask VIDEO_ID ad Title | https://ad1.com,https://ad2.com,https://ad3.com\n/addtask VIDEO_ID channel Title | @channelusername');
     const [,vid,kind,title,url]=match; const v=await env.DB.prepare('SELECT id FROM videos WHERE id=? AND active=1').bind(Number(vid)).first(); if(!v) return send(env,chat,'এই VIDEO_ID পাওয়া যায়নি।');
     if(kind==='ad' && url.split(',').map(x=>x.trim()).length!==3) return send(env,chat,'Ad Task-এর জন্য ঠিক ৩টি URL কমা দিয়ে আলাদা করে দাও।');
     if(kind==='ad' && !url.split(',').every(x=>/^https:\/\//i.test(x.trim()))) return send(env,chat,'প্রতিটি Ad link অবশ্যই https:// হতে হবে।');
     const uname=kind==='channel'?url.replace(/^@/,''):null; const finalUrl=kind==='channel'?`https://t.me/${uname}`:url.split(',').map(x=>x.trim()).join(',');
     await env.DB.prepare('INSERT INTO tasks(video_id,kind,title,url,channel_username,created_at) VALUES(?,?,?,?,?,?)').bind(Number(vid),kind,title,finalUrl,uname,now()).run();
     return send(env,chat,`Task যোগ হয়েছে ভিডিও #${vid}-এ: ${title}`);
   }
   if (text.startsWith('/deletetask ')) { const id=Number(text.split(/\s+/)[1]); await env.DB.prepare('UPDATE tasks SET active=0 WHERE id=?').bind(id).run(); return send(env,chat,'Task বন্ধ করা হয়েছে।'); }
 }
 if (m.chat.type==='private' && (m.text==='/start' || m.text?.startsWith('/start '))) {
   const base=env.APP_URL; return send(env,chat,'🎬 Welcome! Task Complete করলে ভিডিও পাবে।\n\nনিচের বাটনে চাপ দিয়ে ভিডিও ও Task দেখো।', {inline_keyboard:[[{text:'🎬 ভিডিও দেখো / Tasks শুরু করো',web_app:{url:base}}]]});
 }
}
export default {
 async fetch(request,env) {
   if(request.method==='OPTIONS') return new Response(null,{headers:{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST,OPTIONS'}});
   const url=new URL(request.url);
   if(url.pathname==='/telegram-webhook' && request.method==='POST') { const upd=await request.json(); await onUpdate(env,upd); return json({ok:true}); }
   if(url.pathname==='/api/catalog') {
     const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.BOT_TOKEN); if(!user?.id) return json({error:'Open this Mini App from your Telegram bot.'},401);
     const {results:videos=[]}=await env.DB.prepare('SELECT id,title FROM videos WHERE active=1 ORDER BY id DESC').all();
     const items=[];
     for(const v of videos){const {results:tasks=[]}=await env.DB.prepare('SELECT id,kind,title,url,channel_username FROM tasks WHERE video_id=? AND active=1 ORDER BY id').bind(v.id).all(); const {results:done=[]}=await env.DB.prepare('SELECT task_id FROM progress WHERE user_id=? AND video_id=?').bind(String(user.id),v.id).all(); items.push({...v,tasks:tasks.map(t=>({...t,done:done.some(d=>d.task_id===t.id)}))});}
     return json({user:{id:user.id,first_name:user.first_name},videos:items});
   }
   if(url.pathname==='/api/start-task' && request.method==='POST') {
     const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.BOT_TOKEN); if(!user?.id) return json({error:'Unauthorized'},401);
     const {video_id,task_id}=await request.json(); const task=await env.DB.prepare('SELECT * FROM tasks WHERE id=? AND video_id=? AND active=1').bind(Number(task_id),Number(video_id)).first(); if(!task) return json({error:'Task not found'},404);
     if(task.kind==='channel') {
       const member=await tg(env,'getChatMember',{chat_id:`@${task.channel_username}`,user_id:user.id});
       if(member.ok && ['member','administrator','creator'].includes(member.result.status)) { await env.DB.prepare('INSERT OR IGNORE INTO progress(user_id,video_id,task_id,completed_at) VALUES(?,?,?,?)').bind(String(user.id),Number(video_id),Number(task_id),now()).run(); return json({channel_verified:true}); }
     }
     const token=crypto.randomUUID(); await env.DB.prepare('INSERT INTO sessions(token,user_id,video_id,task_id,started_at) VALUES(?,?,?,?,?)').bind(token,String(user.id),Number(video_id),Number(task_id),now()).run();
     return json({token,kind:task.kind,url:task.url,title:task.title,seconds:task.kind==='ad'?10:0});
   }
   if(url.pathname==='/api/complete-task' && request.method==='POST') {
     const user=await verifyInitData(request.headers.get('x-telegram-init-data'),env.BOT_TOKEN); if(!user?.id) return json({error:'Unauthorized'},401);
     const {token}=await request.json(); const s=await env.DB.prepare('SELECT * FROM sessions WHERE token=? AND user_id=? AND used=0').bind(token,String(user.id)).first(); if(!s) return json({error:'Session not found or already used'},400);
     const task=await env.DB.prepare('SELECT * FROM tasks WHERE id=? AND active=1').bind(s.task_id).first(); if(!task) return json({error:'Task unavailable'},400);
     if(task.kind==='ad' && now()-s.started_at<30) return json({error:'Please complete all 3 ads (30 seconds).'},400);
     if(task.kind==='channel') { const member=await tg(env,'getChatMember',{chat_id:`@${task.channel_username}`,user_id:user.id}); if(!member.ok || !['member','administrator','creator'].includes(member.result.status)) return json({error:'প্রথমে Channel Subscribe করো, তারপর Verify চাপো।'},400); }
     await env.DB.prepare('UPDATE sessions SET used=1 WHERE token=?').bind(token).run();
     await env.DB.prepare('INSERT OR IGNORE INTO progress(user_id,video_id,task_id,completed_at) VALUES(?,?,?,?)').bind(String(user.id),s.video_id,s.task_id,now()).run();
     const counts=await env.DB.prepare('SELECT COUNT(*) AS total FROM tasks WHERE video_id=? AND active=1').bind(s.video_id).first(); const completed=await env.DB.prepare('SELECT COUNT(*) AS total FROM progress p JOIN tasks t ON t.id=p.task_id WHERE p.user_id=? AND p.video_id=? AND t.active=1').bind(String(user.id),s.video_id).first();
     if(counts.total>0 && completed.total>=counts.total) { const v=await env.DB.prepare('SELECT title,file_id FROM videos WHERE id=?').bind(s.video_id).first(); await tg(env,'sendVideo',{chat_id:user.id,video:v.file_id,caption:`🎉 ${v.title}\nসব Task Complete হয়েছে!`}); return json({ok:true,video_sent:true}); }
     return json({ok:true,video_sent:false,completed:completed.total,total:counts.total});
   }
   return env.ASSETS.fetch(request);
 }
};
