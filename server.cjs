const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => res.send("🚀 Close Master - Perfect Scoring ✅"));

const MAX_PLAYERS = 7;
const START_CARDS = 7;
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];
let globalCardId = 1;

function cardValue(r) { return r==="A"?1:r==="JOKER"?0:["J","Q","K"].includes(r)?10:parseInt(r)||0; }
function createDeck() {
  let deck = [];
  for(let s of SUITS)for(let r of RANKS)deck.push({id:globalCardId++,suit:s,rank:r,value:cardValue(r)});
  for(let i=0;i<2;i++)deck.push({id:globalCardId++,suit:null,rank:"JOKER",value:0});
  for(let i=deck.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
  return deck;
}

const rooms = new Map();

function roomStateFor(room,pid){
  let top=room.discardPile[room.discardPile.length-1]||null,p=room.players.find(x=>x.id===pid);
  return{roomId:room.roomId,youId:pid,hostId:room.hostId,started:room.started,closeCalled:room.closeCalled,
    currentIndex:room.currentIndex,discardTop:top,pendingDraw:room.pendingDraw,pendingSkips:room.pendingSkips,
    hasDrawn:p?.hasDrawn||false,matchingOpenCardCount:p? p.hand.filter(c=>c.rank===top?.rank).length:0,
    players:room.players.map(p=>({id:p.id,name:p.name,score:p.score,hand:p.id===pid?p.hand:[],handSize:p.hand.length,hasDrawn:p.hasDrawn})),
    log:room.log.slice(-10)}};
}

function broadcast(r){r.players.forEach(p=>io.to(p.id).emit("game_state",roomStateFor(r,p.id)));}
function randomRoomId(){return Array(4).fill().map(()=> "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random()*24)]).join('');}
function ensureDrawPile(r){if(r.drawPile.length>0)return;if(r.discardPile.length<=1)return;let t=r.discardPile.pop(),p=r.discardPile;r.discardPile=[t];for(let i=p.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[p[i],p[j]]=[p[j],p[i]];}r.drawPile=p;}
function setTurnByIndex(r,i){if(!r.players.length)return;r.currentIndex=((i%r.players.length+r.players.length)%r.players.length);r.turnId=r.players[r.currentIndex].id;r.players.forEach(p=>p.hasDrawn=false);}
function advanceTurn(r){let i=r.players.findIndex(p=>p.id===r.turnId);if(i===-1)i=0;let s=1;if(r.pendingSkips>0){s+=r.pendingSkips;r.pendingSkips=0;}let n=(i+s)%r.players.length;r.log.push(`Turn→${r.players[n].name}`);setTurnByIndex(r,n);}
function startRound(r){r.drawPile=createDeck();r.discardPile=[];r.pendingDraw=r.pendingSkips=r.closeCalled=0;r.started=true;r.players.forEach(p=>{p.hand=[];p.hasDrawn=false;p.score=0;});setTurnByIndex(r,0);for(let i=0;i<START_CARDS;i++)r.players.forEach(p=>{ensureDrawPile(r);let c=r.drawPile.pop();if(c)p.hand.push(c);});ensureDrawPile(r);let fc=r.drawPile.pop();if(fc){r.discardPile.push(fc);r.log.push(`Open:${fc.rank}`);if(fc.rank==="7")r.pendingDraw=2;else if(fc.rank==="J")r.pendingSkips=1;}broadcast(r);}

io.on("connection",(s)=>{
  console.log(`🔌${s.id}`);
  s.on("create_room",(d,cb)=>{
    let n=(d?.name||"Player").trim().slice(0,15)||"Player",rId;
    do rId=randomRoomId();while(rooms.has(rId));
    let r={roomId:rId,hostId:s.id,players:[{id:s.id,name:n,score:0,hand:[],hasDrawn:false}],started:false,drawPile:[],discardPile:[],currentIndex:0,turnId:s.id,pendingDraw:0,pendingSkips:0,closeCalled:false,log:[]};
    rooms.set(rId,r);s.join(rId);r.log.push(`${n} created`);cb({roomId:rId,success:true});broadcast(r);
  });
  s.on("join_room",(d,cb)=>{
    let rId=(d?.roomId||"").trim().toUpperCase(),n=(d?.name||"Player").trim().slice(0,15)||"Player";
    if(!rId)return cb({error:"Room ID?"});if(!rooms.has(rId))return cb({error:`${rId} not found`});
    let r=rooms.get(rId);if(r.players.length>=MAX_PLAYERS)return cb({error:"Full"});if(r.started)return cb({error:"Started"});
    r.players.push({id:s.id,name:n,score:0,hand:[],hasDrawn:false});s.join(rId);r.log.push(`${n} joined(${r.players.length}/${MAX_PLAYERS})`);
    cb({roomId:rId,success:true});broadcast(r);
  });
  s.on("start_round",d=>{let rId=d?.roomId;if(!rId||!rooms.has(rId))return;let r=rooms.get(rId);if(r.hostId!==s.id||r.players.length<2)return;startRound(r);});
  s.on("action_draw",d=>{
    let rId=d?.roomId;if(!rId||!rooms.has(rId))return;let r=rooms.get(rId);
    if(!r.started||r.closeCalled||s.id!==r.turnId)return;let p=r.players.find(x=>x.id===s.id);if(!p||p.hasDrawn)return;
    let c=r.pendingDraw>0?r.pendingDraw:1,fd=d?.fromDiscard||false;
    for(let i=0;i;i++){let card;card=fd&&r.discardPile.length>0?r.discardPile.pop():ensureDrawPile(r)?r.drawPile.pop():null;if(card)p.hand.push(card);}
    p.hasDrawn=true;r.pendingDraw=0;broadcast(r);
  });
  s.on("action_drop",d=>{
    let rId=d?.roomId;if(!rId||!rooms.has(rId))return;let r=rooms.get(rId);
    if(!r.started||r.closeCalled||s.id!==r.turnId)return;let p=r.players.find(x=>x.id===s.id),ids=d?.selectedIds||[],sel=p.hand.filter(c=>ids.includes(c.id));
    if(sel.length===0)return;let ur=[...new Set(sel.map(c=>c.rank))];if(ur.length!==1)return;
    let oc=r.discardPile[r.discardPile.length-1],cdw=oc&&ur[0]===oc.rank;if(!p.hasDrawn&&!cdw)return;
    p.hand=p.hand.filter(c=>!ids.includes(c.id));sel.forEach(c=>r.discardPile.push(c));
    let rk=ur[0];if(rk==="J"){r.pendingSkips+=sel.length;}else if(rk==="7"){r.pendingDraw+=2*sel.length;}
    p.hasDrawn=false;advanceTurn(r);broadcast(r);
  });
  
  // ✅ PERFECT CLOSE SCORING
  s.on("action_close",d=>{
    let rId=d?.roomId;if(!rId||!rooms.has(rId))return;
    let r=rooms.get(rId);if(!r.started||r.closeCalled||s.id!==r.turnId)return;
    r.closeCalled=true;
    
    let closer=r.players.find(p=>p.id===s.id);
    let closerPts=closer?closer.hand.reduce((s,c)=>s+c.value,0):0;
    
    r.players.forEach(p=>{
      let pts=p.hand.reduce((s,c)=>s+c.value,0);
      if(p.id===s.id || ptsloserPts){
        p.score=0; // CLOSE player or LOWER → 0
      }else{
        p.score=pts*2; // HIGHER → DOUBLE
      }
    });
    
    r.log.push(`🏁 CLOSE: ${closerPts}pts threshold`);
    broadcast(r);
  });
  
  s.on("disconnect",()=>{
    for(let[rid,r]of rooms){
      if(r.players.some(p=>p.id===s.id)){
        r.players=r.players.filter(p=>p.id!==s.id);
        if(r.players.length===0){rooms.delete(rid);break;}
        if(r.hostId===s.id)r.hostId=r.players[0]?.id;
        if(!r.players.some(p=>p.id===r.turnId))setTurnByIndex(r,0);
        broadcast(r);break;
      }
    }
  });
});

server.listen(process.env.PORT||3000,()=>console.log("🚀 Close Master Server - Perfect Scoring ✅"));
