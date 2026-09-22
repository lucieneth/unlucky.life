/* LIVE DATA CONFIGURATION
       Set endpoint to your own HTTPS, read-only JSON API, e.g. /api/live.
       Never put Discord tokens, Apple tokens, or write credentials in this file.
       Cross-origin endpoints must allow this site's origin with CORS.

       Response shape (all sections optional):
       {
         "xbox": {"lastName":"Forza Horizon 5", "lastSeen":"ISO timestamp"},
         "music": {"updatedAt":"ISO timestamp", "isPlaying":true,
           "title":"Song name","artist":"Artist name",
           "artwork":"https://...", "url":"https://music.apple.com/..."},
         "fitness": {"updatedAt":"ISO timestamp", "date":"YYYY-MM-DD",
           "move":{"value":480,"goal":600},
           "exercise":{"value":24,"goal":30},"stand":{"value":8,"goal":12}}
       }

       Your bot listens for presenceUpdate with GuildPresences intent enabled
       both in the Developer Portal and in its client. Filter YOUR user ID and
       one shared guild; expose only status + selected name/details/type.
       Do not expose raw Discord objects, activity secrets, or other users.
       Refresh updatedAt every ~30s while the Gateway connection is healthy,
       even if your presence is unchanged. A disconnected bot is NOT offline.
       Invisible is indistinguishable from offline. Only shared activities appear.

       Xbox has no public presence API, and every third-party wrapper wants a
       Microsoft login. So the Xbox card rides on Discord instead: link Xbox in
       Discord's Connections, keep "Display current activity as a status
       message" on, and the running game arrives in the same Lanyard payload,
       tagged platform:"xbox". No key, no account, nothing to verify.

       Apple Music recent history is not evidence of current playback.
       True now-playing requires a device bridge reporting play/pause + a heartbeat;
       history-based data MUST use isPlaying:false (shown as 'Recently played').
       Fitness needs an authorized iPhone HealthKit/export bridge. Send only the
       three daily totals and goals, not raw health records. Keep write endpoints
       authenticated on your server. These bridges are not connected in this file.
    */
    // Optional hosted Discord API: join https://discord.gg/lanyard, then set
    // discordUserId to YOUR numeric ID as a string. No bot token is needed.
    // Joining makes your shared presence/activity publicly queryable via Lanyard.
    // Also carries the Xbox card when Xbox is linked in Discord's Connections.
    // It does not connect Apple Music or HealthKit. Leave blank to use your bot.
    const LIVE_CONFIG = { endpoint: 'https://unlucky-live.unlucky.workers.dev/live', discordUserId: '353871885722845188', pollMs: 30000, presenceMaxAgeMs: 120000, musicMaxAgeMs: 120000 };
    const byId = id => document.getElementById(id);
    /* Elements carrying the two-tone display rim draw a second copy of their own
       text in a :before, and a pseudo-element can only take a string from an
       attribute - so anything that opts in with data-text gets it kept in sync
       here rather than at each call site. */
    const put = (id, value) => {
      const el = byId(id);
      el.textContent = value;
      if (el.dataset.text !== undefined) el.dataset.text = value;
    };
    const shortText = value => typeof value === 'string' ? value.slice(0,200) : '';
    const fresh = (value, age) => {
      const delta = Date.now() - Date.parse(value);
      return Number.isFinite(delta) && delta >= -60000 && delta < age;
    };
    const httpsURL = (value, hosts) => {
      try {
        const url = new URL(value);
        if(url.protocol !== 'https:') return '';
        return !hosts || hosts.includes(url.hostname) ? url.href : '';
      } catch { return ''; }
    };
    const DISCORD_CDN = ['cdn.discordapp.com','media.discordapp.net'];
    // Discord serves activity art two ways: an asset id that only means
    // something together with the application it belongs to, or an "mp:" path
    // it already proxies for the app. Anything else is not ours to render.
    const discordArt = a => {
      const img = a && a.assets && a.assets.large_image;
      if(typeof img !== 'string' || !img) return '';
      if(img.startsWith('mp:')) return httpsURL('https://media.discordapp.net/' + img.slice(3), DISCORD_CDN);
      const app = String(a.application_id || '');
      if(/^\d{17,20}$/.test(img) && /^\d{17,20}$/.test(app)) {
        return httpsURL('https://cdn.discordapp.com/app-assets/' + app + '/' + img + '.png', DISCORD_CDN);
      }
      return '';
    };
    // Swap an <img> in over its fallback pictogram. Re-setting an unchanged src
    // would restart the download on every poll and make the icon blink.
    const setImage = (id, src) => {
      const el = byId(id);
      if(src) {
        if(el.getAttribute('src') !== src) el.setAttribute('src', src);
        el.hidden = false;
      } else {
        el.hidden = true;
        el.removeAttribute('src');
      }
    };
    const relTime = value => {
      const delta = Date.parse(value) - Date.now();
      if(!Number.isFinite(delta)) return '';
      const rtf = new Intl.RelativeTimeFormat('en',{numeric:'auto'});
      for(const [unit,ms] of [['day',86400000],['hour',3600000],['minute',60000]]) {
        if(Math.abs(delta) >= ms) return rtf.format(Math.round(delta/ms),unit);
      }
      return rtf.format(Math.round(delta/1000),'second');
    };
    function renderLive(data = {}, unavailable = false) {
      const d = data.discord;
      const states = { online:['Online','#46bd88'], idle:['Away','#e5ac44'], dnd:['Do not disturb','#e26577'], offline:['Offline','#8c8495'] };
      const state = d && fresh(d.updatedAt, LIVE_CONFIG.presenceMaxAgeMs) ? states[d.status] : null;
      document.documentElement.style.setProperty('--presence-color',state ? state[1] : '#8c8495');
      put('topStatus', state ? state[0] + ' · Czechia' : unavailable || d ? 'status unavailable' : 'Status not shared');
      put('discordStatus',state ? state[0] : unavailable || d ? 'Unavailable' : 'Not shared');
      const activity = state && d.status !== 'offline' && d.activity;
      const verbs = {0:'Playing',1:'Streaming',2:'Listening to',3:'Watching',5:'Competing in'};
      put('activityName',activity && shortText(activity.name) ? (verbs[activity.type] || '') + ' ' + shortText(activity.name) : state ? (d.status === 'offline' ? 'Offline' : 'No activity shared') : 'No activity shared');
      setImage('discordAvatar', d && d.avatar ? d.avatar : '');
      put('activityDetails',activity ? shortText(activity.details) : state ? 'Discord' : unavailable || d ? 'The live connection is temporarily unavailable.' : 'My shared Discord activity will appear here.');

      // Live Xbox play comes from Discord's Xbox integration; the bridge only
      // remembers what ran last, so the card is not blank with the console off.
      const xboxNow = d && fresh(d.updatedAt, LIVE_CONFIG.presenceMaxAgeMs) ? d.xbox : null;
      const memory = data.xbox;
      const lastName = memory ? shortText(memory.lastName) : '';
      const lastSeen = memory ? relTime(memory.lastSeen) : '';
      const xColor = xboxNow ? '#4fd18a' : '#8c8495';
      byId('xboxDot').style.background = xColor;
      byId('xboxDot').style.boxShadow = '0 0 8px ' + xColor;
      put('xboxState',xboxNow ? 'Playing now' : lastName ? 'Last session' : state ? 'Idle' : unavailable ? 'Unavailable' : 'Not shared');
      put('xboxStatus',xboxNow ? shortText(xboxNow.name) : lastName || (state ? 'Not playing' : 'Not shared'));
      put('xboxActivity',xboxNow ? (shortText(xboxNow.details) || 'On Xbox') : lastName && lastSeen ? 'Last played ' + lastSeen : 'No recent activity');
      setImage('xboxArt', httpsURL((xboxNow && xboxNow.art) || (memory && memory.lastArt) || '', DISCORD_CDN));
      put('xboxDetail',xboxNow ? 'Shared through Discord' : lastName ? 'Shared through Discord' : unavailable ? 'The live connection is temporarily unavailable.' : 'My last Xbox session will appear here.');

      const m = data.music;
      const hasTrack = m && shortText(m.title);
      const playing = !!(hasTrack && m.isPlaying === true && fresh(m.updatedAt,LIVE_CONFIG.musicMaxAgeMs));
      byId('musicCard').classList.toggle('is-playing',playing);
      put('musicLabel',playing ? 'Currently listening' : hasTrack ? 'Recently played' : 'Apple Music');
      put('musicTitle',hasTrack ? shortText(m.title) : unavailable || (m && m.unavailable) ? 'Unavailable' : m ? 'Nothing playing' : 'Not shared');
      put('musicArtist',hasTrack ? shortText(m.artist) || 'Apple Music' : 'Listening activity not shared');
      const artwork = hasTrack ? httpsURL(m.artwork) : '';
      byId('musicArtwork').hidden = !artwork;
      if(artwork) byId('musicArtwork').src = artwork; else byId('musicArtwork').removeAttribute('src');
      const songURL = hasTrack ? httpsURL(m.url,['music.apple.com']) : '';
      byId('musicLink').hidden = !songURL;
      if(songURL) byId('musicLink').href = songURL; else byId('musicLink').removeAttribute('href');

      const f = data.fitness;
      const dateParts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
      const part = kind => dateParts.find(p=>p.type===kind).value;
      const today = `${part('year')}-${part('month')}-${part('day')}`;
      const current = f && f.date === today;
      const summaries = [];
      for(const [key,unit] of [['move','kcal'],['exercise','min'],['stand','hr']]) {
        const metric = current && f[key];
        const valid = metric && Number.isFinite(metric.value) && metric.value >= 0 && Number.isFinite(metric.goal) && metric.goal > 0;
        const text = valid ? `${Math.round(metric.value)} / ${metric.goal} ${unit}` : `— ${unit}`;
        put(key+'Value',text);
        byId(key+'Ring').style.strokeDashoffset = valid ? 100 - Math.min(100,metric.value / metric.goal * 100) : 100;
        if(valid) summaries.push(`${key}: ${text}`);
      }
      byId('fitnessRings').setAttribute('aria-label',summaries.length ? summaries.join(', ') : 'Fitness data unavailable');
      const updated = f && Date.parse(f.updatedAt);
      put('fitnessSync',current && summaries.length ? (Number.isFinite(updated) ? 'Updated ' + new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',hour:'2-digit',minute:'2-digit',hour12:false}).format(updated) : 'Updated today') : unavailable || f ? (f && !current ? "Waiting for today's activity" : 'Unavailable') : 'Not shared');
    }
    for(const id of ['musicArtwork','discordAvatar','xboxArt']) {
      byId(id).addEventListener('error',()=>{byId(id).hidden=true;});
    }
    let lastLiveData = {};
    function normalizeLanyard(payload) {
      const data = payload && payload.success === true && payload.data;
      if(!data || data.discord_user?.id !== LIVE_CONFIG.discordUserId || !['online','idle','dnd','offline'].includes(data.discord_status)) {
        throw new Error('Lanyard user unavailable; check server membership and user ID');
      }
      const activities = Array.isArray(data.activities) ? data.activities : [];
      const playable = a => a && [0,1,2,3,5].includes(a.type) && typeof a.name === 'string';
      // Discord tags console activities with a platform, so an Xbox session can
      // feed its own card instead of being repeated on the Discord one.
      const xbox = activities.find(a=>playable(a) && a.platform === 'xbox');
      const activity = activities.find(a=>playable(a) && a !== xbox);
      const pick = a => ({ name:shortText(a.name), type:a.type,
        details:shortText(a.details || a.state), art:discordArt(a) });
      const live = data.discord_status !== 'offline';
      // The avatar hash changes whenever the picture does, and this refetches
      // on every poll, so the card follows a new profile picture on its own.
      const hash = data.discord_user?.avatar;
      const avatar = typeof hash === 'string' && /^(a_)?[a-f0-9]{32}$/i.test(hash)
        ? httpsURL('https://cdn.discordapp.com/avatars/' + LIVE_CONFIG.discordUserId +
            '/' + hash + (hash.startsWith('a_') ? '.gif' : '.png') + '?size=128', DISCORD_CDN)
        : '';
      return { updatedAt:new Date().toISOString(), status:data.discord_status, avatar,
        activity: activity && live ? pick(activity) : null,
        xbox: xbox && live ? pick(xbox) : null };
    }
    let liveRequestPending = false;
    async function refreshLive() {
      const useLanyard = /^\d{17,20}$/.test(LIVE_CONFIG.discordUserId);
      if((!LIVE_CONFIG.endpoint && !LIVE_CONFIG.discordUserId) || liveRequestPending) return;
      liveRequestPending = true;
      const controller = new AbortController();
      const timeout = setTimeout(()=>controller.abort(),8000);
      try {
        const getJSON = async url => {
          const response = await fetch(url,{cache:'no-store',signal:controller.signal,credentials:'omit'});
          if(!response.ok) throw new Error('Live data unavailable');
          return response.json();
        };
        const [combined,discord] = await Promise.allSettled([
          LIVE_CONFIG.endpoint ? getJSON(LIVE_CONFIG.endpoint) : Promise.resolve({}),
          useLanyard ? getJSON('https://api.lanyard.rest/v1/users/' + LIVE_CONFIG.discordUserId).then(normalizeLanyard) : Promise.resolve(null)
        ]);
        const validCombined = combined.status === 'fulfilled' && combined.value && typeof combined.value === 'object' && !Array.isArray(combined.value);
        const data = validCombined ? {...combined.value} : {discord:{},music:{unavailable:true},fitness:{}};
        if(LIVE_CONFIG.discordUserId) data.discord = useLanyard && discord.status === 'fulfilled' ? discord.value : {};
        lastLiveData = data;
        renderLive(data);
      } catch { lastLiveData = {}; renderLive({},true); }
      finally { clearTimeout(timeout); liveRequestPending = false; }
    }
    renderLive();
    refreshLive();
    setInterval(()=>{if(!document.hidden) {renderLive(lastLiveData); refreshLive();}},LIVE_CONFIG.pollMs);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) {renderLive(lastLiveData); refreshLive();}});

    // Birthday from https://unlucky.life/javascript/index.js.
    // Use calendar dates in the owner's time zone, not elapsed milliseconds.
    const BIRTH_DATE = { year:2002, month:6, day:24 };
    function ageOnDate(now = new Date()) {
      const parts = new Intl.DateTimeFormat('en-GB',{
        timeZone:'Europe/Prague',year:'numeric',month:'numeric',day:'numeric'
      }).formatToParts(now);
      const value = type => Number(parts.find(p=>p.type===type).value);
      const year = value('year'), month = value('month'), day = value('day');
      return year - BIRTH_DATE.year - Number(month < BIRTH_DATE.month || (month === BIRTH_DATE.month && day < BIRTH_DATE.day));
    }
    function updateAge() {
      const age = ageOnDate();
      if(byId('ageValue').textContent !== String(age)) put('ageValue',String(age));
      byId('ageLine').hidden = false;
    }
const root=document.documentElement;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const preferences={get(key){try{return localStorage.getItem(key)}catch{return null}},set(key,value){try{localStorage.setItem(key,value)}catch{}}};

/* ============================================================
   First-load overlay - taking it away
   ============================================================ */

/* The overlay and its scroll lock ship in the markup, because anything added
   from here lands a frame or two after the first paint, which is the exact
   flash it exists to cover. This end only decides when it goes.

   Three numbers, all of them about not wasting anyone's time. MIN_VISIBLE
   stops a warm cache turning the overlay into a blink. MAX_WAIT means a hung
   font or a stalled image can never strand a visitor behind it. EXIT_GRACE
   lets a sweep that is nearly home finish rather than be cut in half - but
   only when nearly home is actually near, otherwise it fades where it is.

   This sits above everything that runs on load on purpose: a throw further
   down the file must not be able to leave the page locked. */
const loader=byId('loader');
if(loader){
  const MIN_VISIBLE=900,MAX_WAIT=6000,EXIT_GRACE=600;
  const shownAt=performance.now();
  const band=loader.querySelector('.ul-band');
  let gone=false;

  /* The scroll lock. overflow:hidden on the root was the obvious way to do
     this and the wrong one: it takes the scrollbar away, the page relaid out a
     scrollbar's width wider underneath, and everything slid back sideways the
     moment the overlay lifted. scrollbar-gutter only hides that where it is
     supported. Blocking the events that scroll leaves the layout untouched,
     which is the only version that cannot shift anything. */
  const SCROLL_KEYS=new Set([' ','Spacebar','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End']);
  const stop=e=>e.preventDefault();
  const stopKey=e=>{if(SCROLL_KEYS.has(e.key))e.preventDefault()};
  const lock=(how)=>{
    how('wheel',stop,{passive:false});
    how('touchmove',stop,{passive:false});
    how('keydown',stopKey);
  };
  lock(addEventListener);

  root.classList.add('ul-hold');
  const drop=()=>{if(gone)return;gone=true;lock(removeEventListener);loader.remove();root.classList.remove('ul-hold')};
  /* animationend is the signal; the timer is for the case where the exit
     animation never runs at all. Either way the lock comes off. */
  const leave=()=>{
    loader.addEventListener('animationend',e=>{if(e.target===loader)drop()});
    loader.classList.add('is-leaving');
    setTimeout(drop,900);
  };
  /* How much of the sweep's cycle is left. getAnimations is the only way to
     ask a CSS animation where it is; currentTime is a plain number today but
     is specified as CSSNumberish, so it is read rather than assumed. Anything
     unsupported reads as 0, which just means fade now. */
  const sweepLeft=()=>{
    try{
      const a=band&&band.getAnimations()[0];
      if(!a||!a.effect)return 0;
      const span=a.effect.getTiming().duration;
      const at=typeof a.currentTime==='number'?a.currentTime:(a.currentTime&&a.currentTime.value)||0;
      return span-(at%span);
    }catch{return 0}
  };
  /* Ready means the load event and the display faces both settled - the page
     is set in GTAArtDeco and Pricedown, and a reflow from fallback metrics is
     one of the things the overlay is covering. MAX_WAIT caps the lot. */
  const ready=Promise.all([
    new Promise(go=>document.readyState==='complete'?go():addEventListener('load',go,{once:true})),
    document.fonts?document.fonts.ready:Promise.resolve()
  ]);
  Promise.race([ready,new Promise(go=>setTimeout(go,MAX_WAIT))]).then(()=>{
    setTimeout(()=>{
      const rest=sweepLeft();
      if(rest>0&&rest<=EXIT_GRACE)setTimeout(leave,rest);else leave();
    },Math.max(0,MIN_VISIBLE-(performance.now()-shownAt)));
  });
}

/* ============================================================
   Visitor greeting and visit notification - ipdata.co
   ============================================================ */

/* One ipdata call feeds both the masthead greeting and the Discord ping, the
   same source and embed shape the other sites in this project use.

   The markup ships with "hey, i'm" already in it and this only overwrites on
   success, so a blocked request, a spent quota, an ad blocker or a privacy
   extension all leave the original greeting standing. Nothing awaits any of it.

   The ipdata key is in the clear, and that is not a regression: the other sites
   run it through CryptoJS with the password "helloworld" hardcoded three lines
   away, which hides it from nobody. A client-side key cannot be secret - lock
   it to the domain in the ipdata dashboard instead. */
const IPDATA_KEY='ad232f1daf9e88efd3dc4f63734d426f5f3c93bee2e7a3ebf5f31893';

/* Two channels, first-time and returning. The base64 is carried over from the
   other sites for parity; it is encoding, not protection. A webhook URL is a
   write credential for its channel and this file ships to every visitor, so
   anyone who reads it can post to both channels. Moving these behind the
   worker that already serves /live would be the fix. */
const VISIT_HOOKS={
  new:'aHR0cHMlM0ElMkYlMkZkaXNjb3JkLmNvbSUyRmFwaSUyRndlYmhvb2tzJTJGOTk4OTMwODM4Mzc0ODQ2NTE0JTJGT2xqZGFDclhxcXByM1R0dlVpMzJtOEFzcnNmdnpjNDFUTlROblJWeThCbThzM2J4T1BSZWZSbExjdVRVUlJqaE93czA=',
  returning:'aHR0cHMlM0ElMkYlMkZkaXNjb3JkLmNvbSUyRmFwaSUyRndlYmhvb2tzJTJGOTk4OTQ1NTAyMzg3MjQ5MjkzJTJGX25XYTQ4THVHRTVJRUhvSDhUUU5IM0FzUHBLOVlLbWFYSy1uM3FNdkgwVnFXTFg5UkotYnlUekRkMzdDT3gzdUQ2NTE='
};

/* The other sites call this a cookie but write localStorage['first-visit'].
   localStorage is the better fit anyway - it never rides along on requests -
   so the mechanism is kept and routed through the guarded wrapper above.
   Someone in a private window, or with storage blocked, reads back null and
   counts as new every time; preferences swallows the throw either way. */
const VISIT_KEY='lucien-first-visit';

function greetingFor(hour){
  if(hour>=5&&hour<12)return 'Good morning';
  if(hour>=12&&hour<18)return 'Good afternoon';
  return 'Good night';
}

function paintGreeting(data){
  const slot=byId('userGreet');
  if(!slot)return;
  /* current_time comes back already in the visitor's own zone, so a plain
     getHours on it is their local hour - no offset arithmetic. When the tier
     in use does not return time_zone, the browser's own hour is the same
     thing anyway, so the greeting survives that too. */
  const stamp=data.time_zone&&data.time_zone.current_time;
  const fromZone=stamp?new Date(stamp).getHours():NaN;
  const hour=Number.isFinite(fromZone)?fromZone:new Date().getHours();
  slot.textContent=greetingFor(hour)+' ';
  slot.appendChild(document.createElement('em')).textContent=data.ip;
  slot.append(", i'm");
}

function visitEmbed(kind,data){
  const asn=data.asn||{};
  const place=[data.city,data.region,data.region_code].filter(Boolean).join(', ');
  return {
    title:kind+' visitor from '+(data.country_name||'unknown')+' ('+(data.country_code||'??')+')',
    description:'**'+(place||'unknown')+'**'
      +'\nIP: ||**'+data.ip+'**|| provided by **'+(asn.name||'unknown')+'**'
      +'\nIP type: **'+(asn.type||'unknown')+'**',
    thumbnail:{url:data.flag||''},
    footer:{text:'unlucky.life',icon_url:'https://unlucky.life/images/favicon/favicon-32x32.webp'},
    timestamp:new Date().toISOString(),
    color:0x737dfe
  };
}

function announceVisit(data){
  const returning=preferences.get(VISIT_KEY)==='true';
  const kind=returning?'old':'new';
  preferences.set(VISIT_KEY,'true');
  /* Plain cors mode, not no-cors: Discord answers the preflight, and no-cors
     would strip the JSON content type down to a simple header and break the
     body. keepalive so the POST still lands if the tab is closed on arrival. */
  fetch(decodeURIComponent(atob(VISIT_HOOKS[returning?'returning':'new'])),{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    keepalive:true,
    body:JSON.stringify({username:'website notification',embeds:[visitEmbed(kind,data)]})
  }).catch(()=>{});
}

async function greetVisitor(){
  let data;
  try{
    const response=await fetch('https://api.ipdata.co/?api-key='+IPDATA_KEY,{credentials:'omit'});
    if(!response.ok)return;
    data=await response.json();
  }catch{return}
  if(!data||typeof data.ip!=='string')return;
  // Kept apart so one failing does not take the other down with it.
  try{paintGreeting(data)}catch{}
  try{announceVisit(data)}catch{}
}
greetVisitor();
let paused=preferences.get('lucien-motion')==='paused';
const moves=()=>!paused&&!reduced.matches;
function syncMotion(){const on=moves();root.classList.toggle('motion-off',!on);const b=byId('motionToggle');b.setAttribute('aria-pressed',String(!on));b.setAttribute('aria-label',reduced.matches?'Reduced motion enabled by your system':on?'Pause motion':'Resume motion');b.title=b.getAttribute('aria-label');b.disabled=reduced.matches;byId('motionIcon').setAttribute('href',on?'#icon-pause':'#icon-play');if(!on){document.querySelectorAll('.reveal').forEach(e=>e.classList.add('visible'))}restartBubbles();}
syncMotion();byId('motionToggle').addEventListener('click',()=>{paused=!paused;preferences.set('lucien-motion',paused?'paused':'on');syncMotion()});reduced.addEventListener('change',syncMotion);
// The scene now swaps the whole palette, so the browser chrome follows it too.
/* Keep these in step with body / body.sunset in the stylesheet - this is what
   the browser chrome tints itself with, so a stale value here shows up as a
   band that does not match the page. */
const SCENE_THEME={sunset:'#0f1638',daylight:'#e5b8ce'};
function setScene(sunset){document.body.classList.toggle('sunset',sunset);byId('mode').setAttribute('aria-pressed',String(sunset));byId('mode').setAttribute('aria-label',sunset?'Switch to daylight scene':'Switch to sunset scene');put('modeLabel',sunset?'Sunset':'Daylight');document.querySelector('meta[name="theme-color"]').content=sunset?SCENE_THEME.sunset:SCENE_THEME.daylight;reseedBubbles();}
setScene(preferences.get('lucien-vice-scene')!=='daylight');byId('mode').addEventListener('click',()=>{const sunset=!document.body.classList.contains('sunset');setScene(sunset);preferences.set('lucien-vice-scene',sunset?'sunset':'daylight')});
/* ============================================================
   Liquid-filled background - this page's wiring
   ============================================================ */

/* The palette is read out of CSS, the same way the old engine read its tints,
   so retuning the look stays a stylesheet edit. */
var liquidFx=null;
const LIQUID_STOPS=['abyss','deep','violet','orchid','blush','sun','aqua'];
function liquidPalette(){
  const s=getComputedStyle(document.body),out={};
  for(const k of LIQUID_STOPS)out[k]=s.getPropertyValue('--lb-'+k).trim()||'#16204a';
  return out;
}

/* depth is not a darkening knob: the shader applies it as
   col *= (1-depth) + depth*2*smoothstep(uv.y), so it darkens the bottom and
   brightens the TOP by the same factor. On the dark scene that reads as light
   entering a tank. On daylight, where the glare complaint is about the upper
   half of the page, turning it up is exactly the wrong move - it stays low
   here, and the scene gets its shape from the palette range and the vignette
   instead. */
const LIQUID_SCENE={
  sunset:{depth:.36,vignette:.3,edge:.15,veil:.55,opacity:.65,wall:1},
  daylight:{depth:.08,vignette:.24,edge:.12,veil:.42,opacity:.62,wall:1}
};

const LIQUID_CONFIG={
  /* opacity below 1 lets this page's own background gradient through
     underneath, so a pale pool can never swallow the text sitting on it.
     LIQUID_SCENE sets the per-scene value; this is only the starting point. */
  /* Two halves. wall bounds the medium: its noise used to translate linearly
     and cross the whole viewport in about two minutes, so whatever led the way
     was gone for good; at 1 it wanders the same distances and comes back.
     pools are the big pink shapes as actual objects - metaballs that reverse
     off the glass the way they came, kept round because a compressed noise
     field can only ever flatten them into planes along the wall.

     minRadius is high and the count sits near the shader's cap of 12 on
     purpose. Small blobs read as little round bubbles sitting on top of the
     liquid rather than as pigment in it, and a sparse set leaves single ones
     standing alone as clean circles - crowding large ones makes them merge
     into poured masses instead. speed is a fraction of the short side per
     second, so .008 is about 6px/s: roughly 150s to cross the viewport.

     wobble runs the medium's own warp through their outlines so they are
     round without being circles; past about .1 it starts faceting them flat
     again, which defeats the point. */
  liquid:{flow:.085,scale:2.6,veil:.55,caustics:0,soften:.1,depth:.36,vignette:.3,edge:.15,grain:0,opacity:.7,wall:1,pools:{count:11,minRadius:.22,maxRadius:.32,speed:.008,wobble:.07}},
  /* The bubbles are tuned but switched off: every one of their appearance
     knobs is at zero, so the effect is the liquid alone. Raise
     bubbles.opacity to bring the whole field back with these settings
     (and drop the .lb__fb i rule in the stylesheet). */
  bubbles:{density:.5,minRadius:3,maxRadius:30,sizeBias:1,rise:2,sizeSpeed:-1,
           inertia:.1,drift:0,wobble:0,jitter:0,cluster:0,
           opacity:0,refraction:0,rim:0,highlight:0,glow:0},
  container:{radius:0},
  interaction:{strength:.2,radius:230,swirl:.55,parallax:6},
  performance:{liquidScale:.6}
};

/* Kept under their old names: syncMotion() and setScene() already call these,
   and the motion toggle on this page overrides the media query, so the engine
   is told explicitly rather than left on 'auto'. */
function restartBubbles(){if(liquidFx)liquidFx.update({motion:moves()});}
function reseedBubbles(){
  if(!liquidFx)return;
  const scene=document.body.classList.contains('sunset')?'sunset':'daylight';
  liquidFx.update({palette:liquidPalette(),liquid:LIQUID_SCENE[scene]});
}

liquidFx=LiquidBubbles.create('#bubbles',Object.assign({},LIQUID_CONFIG,{
  palette:liquidPalette(),motion:moves()
}));
reseedBubbles();

function updateClock(){const now=new Date();updateAge();const t=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);const z=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',timeZoneName:'short'}).formatToParts(now).find(p=>p.type==='timeZoneName').value;put('localTime',t);put('timeZone',z);put('localDate',new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',day:'numeric',month:'short'}).format(now));put('year',now.getFullYear());}
updateClock();setInterval(()=>{if(!document.hidden)updateClock()},15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateClock()});
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');observer.unobserve(e.target)}})},{threshold:.06});document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));if(moves())root.classList.add('js-motion');}
// Pointer drift: the sparkles lag a little behind the cursor.
let pending=false,x=0,y=0;function paint(){pending=false;const h=root.scrollHeight-innerHeight;byId('progress').style.transform=`scaleX(${h>0?scrollY/h:0})`;if(!moves())return;root.style.setProperty('--tilt-x',x*-9+'px');root.style.setProperty('--tilt-y',y*-6+'px')};function schedule(){if(!pending){pending=true;requestAnimationFrame(paint)}}
document.querySelector('.hero').addEventListener('pointermove',e=>{if(!moves()||e.pointerType==='touch')return;const r=e.currentTarget.getBoundingClientRect();x=(e.clientX-r.left)/r.width-.5;y=(e.clientY-r.top)/r.height-.5;schedule()},{passive:true});document.querySelector('.hero').addEventListener('pointerleave',()=>{x=y=0;schedule()});addEventListener('scroll',schedule,{passive:true});addEventListener('resize',schedule,{passive:true});schedule();
let toastTimer;function showToast(text){put('toast',text);byId('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>byId('toast').classList.remove('show'),2500)}
byId('copyEmail').addEventListener('click',async()=>{let ok=false;try{await navigator.clipboard.writeText('hello@unlucky.life');ok=true}catch{const box=document.createElement('textarea');box.value='hello@unlucky.life';box.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(box);box.select();try{ok=document.execCommand('copy')}catch{}box.remove();byId('copyEmail').focus()}showToast(ok?'Email copied — say hello!':'hello@unlucky.life');put('copyLabel',ok?'copied!':'copy');setTimeout(()=>put('copyLabel','copy'),2500)});

const palette=byId('palette'),search=byId('paletteSearch');
const commands=[...palette.querySelectorAll('[data-command]')];
function filterCommands(){const value=search.value.trim().toLowerCase();commands.forEach(e=>e.hidden=!e.dataset.command.includes(value));byId('paletteEmpty').hidden=commands.some(e=>!e.hidden)}
function openCommands(){if(palette.open)return;search.value='';filterCommands();palette.showModal();search.focus()}
byId('openPalette').addEventListener('click',openCommands);byId('closePalette').addEventListener('click',()=>palette.close());
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();palette.open?palette.close():openCommands()}});
search.addEventListener('input',filterCommands);
palette.addEventListener('keydown',e=>{const visible=commands.filter(c=>!c.hidden);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!visible.length)return;const index=visible.indexOf(document.activeElement);const next=index<0?(e.key==='ArrowDown'?0:visible.length-1):(index+(e.key==='ArrowDown'?1:-1)+visible.length)%visible.length;visible[next].focus()}else if(e.key==='Enter'&&document.activeElement===search&&visible.length){e.preventDefault();visible[0].click()}});
palette.addEventListener('click',e=>{if(e.target===palette){const r=palette.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)palette.close()}});
commands.filter(e=>e.tagName==='A').forEach(e=>e.addEventListener('click',()=>palette.close()));
byId('paletteCopy').addEventListener('click',()=>{palette.close();byId('copyEmail').click()});byId('paletteScene').addEventListener('click',()=>{palette.close();byId('mode').click()});
if(/Mac|iPhone|iPad/.test(navigator.platform))put('shortcutHint','⌘ K');
function markLocalHour(){const hour=Number(byId('localTime').textContent.split(':')[0]);document.querySelectorAll('.clock-track i').forEach((tick,index)=>tick.classList.toggle('current',index===hour))}markLocalHour();new MutationObserver(markLocalHour).observe(byId('localTime'),{childList:true,characterData:true,subtree:true});
