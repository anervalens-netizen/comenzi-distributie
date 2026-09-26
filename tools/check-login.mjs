import {readFileSync} from 'node:fs';
const users=JSON.parse(readFileSync('../tools/test-credentials.json','utf8'));
const u=users.find(u=>u.username==='manager');
const res=await fetch('http://localhost:3000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.username,password:u.password})});
const json=await res.json();
console.log(JSON.stringify({status:res.status,user:json.user?.username,mustChangePassword:json.user?.mustChangePassword,error:json.error}));
if(!res.ok)process.exitCode=1;
