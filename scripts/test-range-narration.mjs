// node scripts/test-range-narration.mjs — no API, filesystem audio or user projects.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const hooks = { posters: [], requests: [], discarded: [], history: [], notifications: [], speak: null };
globalThis.__rangeTest = hooks;
const mocks = {
  '@/lib/viral/poster': `export const READABLE_WIDTH=768; export async function poster(asset,at){globalThis.__rangeTest.posters.push({id:asset.id,at});return 'data:image/jpeg;base64,dGVzdA==';}`,
  '@/lib/ai/client': `export async function generate(model,body,options){globalThis.__rangeTest.requests.push({model,body,options});return {text:JSON.stringify({title:'Validation',say:'On valide la fiche pour enregistrer les modifications.'})};}`,
  '@/lib/voice/client': `export async function speak(request){return globalThis.__rangeTest.speak(request)};export async function discard(keys){globalThis.__rangeTest.discarded.push(...keys)}`,
  '@/lib/media': `export async function assetFromPath(path){return {id:path,kind:'audio',path,src:path,name:'voice',duration:0,addedAt:0,width:null,height:null,size:100}}`,
  '@/store/tutorialStore': `export const useTutorial={getState:()=>({options:{assetId:'a',brief:'Ancien contexte'}})};`,
  '@/store/aiStore': `export const useAi={getState:()=>({keyStatus:{configured:true},settings:{model:'mock',fallbacks:false}})};`,
  '@/store/voiceStore': `export const canSpeak=()=>true;export const useVoice={getState:()=>({preferences:{voiceId:'v',modelId:'m',settings:{}}})};`,
  '@/store/editorStore': `
    export const projectDuration=project=>Math.max(0,...project.clips.map(c=>c.start+c.duration));
    const state={project:null,playhead:0,workIn:null,workOut:null,
      pause(){},selectClip(id){state.selectedClipId=id},notify(text){globalThis.__rangeTest.notifications.push(text)},
      transact(label,change){const next=change(state.project);globalThis.__rangeTest.history.push({label,project:state.project});state.project=next;}};
    export const useEditor={getState:()=>state,setState:patch=>Object.assign(state,patch)};
  `,
};
const result = await build({
  stdin: { contents: `export * from './src/lib/tutorial/rangeNarration';export {useRangeNarration} from './src/store/rangeNarrationStore';export {useEditor} from '@/store/editorStore';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
      const key = path.startsWith('./') && importer.endsWith('rangeNarrationStore.ts') ? '@/store/' + path.slice(2) : path;
      if (key in mocks) return { path: key, namespace: 'mock' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: mocks[path] }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const { validateNarrationRange, narrationFrameAt, narrationFingerprint, draftRangeNarration, placeRangeNarration, useRangeNarration, useEditor } = api;
const asset = id => ({ id,kind:'video',name:id,src:id,path:id,duration:100,width:1920,height:1080,addedAt:0,size:100 });
const track = (id,kind='video') => ({id,kind,name:id,height:64,muted:false,solo:false,hidden:false,locked:false});
const clip = (id,trackId,assetId,start,duration,offset=0) => ({id,trackId,assetId,start,duration,offset,kind:'media',volume:1,opacity:1,scale:1,x:0,y:0,rotation:0,muted:false,effects:[]});
const a=asset('a'), b=asset('b');
const project={id:'p',name:'test',createdAt:0,updatedAt:0,settings:{width:1920,height:1080,fps:30},assets:[a,b],tracks:[track('hidden'),track('screen'),track('sound','audio')],
  clips:[clip('hidden','hidden','b',0,40),clip('a','screen','a',0,20,5),clip('b','screen','b',20,20,50),clip('sound','sound','a',0,40)],transitions:[],schemaVersion:11,tutorialContext:'Logiciel de caisse, vouvoyer.'};
project.tracks[0].hidden=true;
const range={start:10,end:25};
validateNarrationRange(project,range);
for(const invalid of [{start:-1,end:3},{start:1,end:1},{start:39,end:45},{start:NaN,end:20}]) assert.throws(()=>validateNarrationRange(project,invalid));
assert.equal(narrationFrameAt(project,12).sourceTime,17);
assert.equal(narrationFrameAt(project,22).sourceTime,52);
assert.equal(narrationFrameAt(project,12).asset.id,'a','Hidden top track ignored');
const before=JSON.stringify(project);
const proposal=await draftRangeNarration(project,range,project.tutorialContext,'Explique la validation.',{model:'mock',fallbacks:false},new AbortController().signal,()=>{});
assert.equal(proposal.images,15);
assert.equal(proposal.missing,0);
assert.ok(hooks.posters.some(p=>p.id==='a'&&p.at>=15)&&hooks.posters.some(p=>p.id==='b'&&p.at>=50));
assert.ok(hooks.requests[0].body.contents[0].parts[0].text.includes(project.tutorialContext));
assert.equal(JSON.stringify(project),before);
const controller=new AbortController();controller.abort();
await assert.rejects(()=>draftRangeNarration(project,range,'context','',{model:'mock'},controller.signal,()=>{}));

const take={path:'voice.mp3',duration:3.2,words:[],bytes:100};
const voiceAsset={...asset('voice'),kind:'audio',path:take.path,duration:take.duration};
const placed=placeRangeNarration(project,range,take,voiceAsset,'Voix',{clip:'voice-clip',track:'voice-track'});
assert.equal(placed.clips.length,project.clips.length+1);
assert.equal(placed.clips.at(-1).start,10);
assert.ok(placed.clips.at(-1).start+placed.clips.at(-1).duration<=25);
assert.equal(placed.settings,project.settings);
project.clips.forEach((clip,i)=>assert.equal(placed.clips[i],clip));
assert.equal(placed.tutorialContext,project.tutorialContext);
assert.equal(narrationFingerprint(placed,range),narrationFingerprint(project,range),'Audio addition does not invalidate video analysis');
assert.throws(()=>placeRangeNarration(project,range,{...take,duration:20},voiceAsset,'Voix',{clip:'v',track:'t'}));
assert.equal(JSON.stringify(project),before);

useEditor.setState({project,workIn:10,workOut:25,playhead:0});
const state=()=>useRangeNarration.getState();
state().openWizard();
assert.deepEqual(state().range,range);
assert.equal(state().context,project.tutorialContext);
state().configure({context:'Contexte mémorisé',instruction:'Explique ce clic.'});
await state().generate();
assert.equal(useEditor.getState().project.tutorialContext,'Contexte mémorisé');
assert.ok(state().text);
assert.equal(useEditor.getState().project.clips.length,project.clips.length,'Drafting does not place media');
hooks.speak=async request=>({...take,path:request.key+'.mp3'});
await state().synthesize();
assert.ok(state().asset&&state().take);
const insertedPath=state().take.path;
const historyBefore=hooks.history.length;
state().insert();
assert.equal(hooks.history.length,historyBefore+1,'Insertion is exactly one transaction');
assert.equal(state().placed,true);
const afterInsert=useEditor.getState().project;
state().insert();
assert.equal(useEditor.getState().project,afterInsert,'Double insertion is ignored');
state().configure({text:'Nouvelle phrase.'});
assert.ok(!hooks.discarded.some(key=>insertedPath===key+'.mp3'),'Placed take is never deleted');

// A late voice response after cancel must not be inserted or retained.
let complete;
hooks.speak=request=>new Promise(resolve=>{complete=()=>resolve({...take,path:request.key+'.mp3'});});
const pending=state().synthesize();
assert.ok(state().busy);
state().cancel();complete();await pending;
assert.equal(state().take,null);
assert.ok(hooks.discarded.length>0);
assert.equal(useEditor.getState().project,afterInsert);

hooks.speak=async request=>({...take,path:request.key+'.mp3',duration:20});
await state().synthesize();state().insert();
assert.ok(state().error.includes('dépasse'));
assert.equal(useEditor.getState().project,afterInsert);

// Same ID, edited pictures: reject an outdated proposal.
state().configure({text:'Autre phrase.'});
hooks.speak=async request=>({...take,path:request.key+'.mp3'});
await state().synthesize();
useEditor.setState({project:{...afterInsert,clips:afterInsert.clips.map(c=>c.id==='a'?{...c,offset:8}:c)}});
state().insert();assert.ok(state().error.includes('changé'));

// Pending requests cannot cross a project switch.
state().configure({range:{start:11,end:24},text:'Texte direct.'});
hooks.speak=request=>new Promise(resolve=>{complete=()=>resolve({...take,path:request.key+'.mp3'});});
const switching=state().synthesize();
useEditor.setState({project:{...project,id:'other'}});complete();await switching;
assert.equal(state().take,null);
assert.equal(useEditor.getState().project.id,'other');
state().close();state().openWizard();
assert.equal(state().context,project.tutorialContext,'New project uses its own saved context');
delete globalThis.__rangeTest;
console.log('PASS: I/O range, source offsets across cuts, hidden tracks, context persistence, mocked draft/voice, audio-only insertion, single transaction, duration bounds, stale edits, cancel/project-switch cleanup and protected inserted takes.');
