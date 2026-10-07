import { it, expect } from 'vitest';
import { advance } from '../ops/monitoring/checker/state.mjs';
const track = { count: 1, hash: 'd'.repeat(32), content_hash: 'a'.repeat(32), watermark: '9007199254740993' };
const mirror = { count: 1, hash: track.hash, content_hash: 'b'.repeat(32), cursor: '4:8', held: false };
it('reports content drift after three stable samples with matching versions', () => {
  let state;
  for (let i=1;i<=3;i++) { state=advance(state,track,mirror,100+i); expect(state.match).toBe(i===3?0:-1); }
  expect(state.mismatches).toBe(1);
  expect(state.differenceSince).toBe(101);
  expect(advance(state,track,mirror,104).mismatches).toBe(1);
  expect(advance(state,track,{...mirror,content_hash:track.content_hash},105).match).toBe(1);
});
it('keeps possible lag pending even when the source remains stable', () => {
  for (const changed of [{count: 0}, {hash: 'e'.repeat(32)}, {hash: undefined}]) {
    let state;
    for (let i=0;i<5;i++) state=advance(state,track,{...mirror,...changed},100+i);
    expect(state.match).toBe(-1);
    expect(state.pending).toBe(true);
    expect(state.mismatches).toBe(0);
  }
});
it('resets streak on source change or held state; xmin advancement alone does not imply drift', () => {
  const state=advance(undefined,track,mirror,100);
  expect(advance({...state,streak:2},track,{...mirror,held:true},101).streak).toBe(0);
  expect(advance({...state,streak:2},{...track,content_hash:'c'.repeat(32)},mirror,101).streak).toBe(1);
  expect(advance({...state,streak:2},{...track,watermark:'9007199254740994'},mirror,101).match).toBe(0);
  expect(()=>advance(state,{...track,watermark:null},mirror,101)).toThrow();
});

it('persists counters atomically while requiring fresh observations after restart', async()=>{
  const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {loadCounters,saveCounters}=await import('../ops/monitoring/checker/storage.mjs');
  const folder=await mkdtemp(join(tmpdir(),'prsi-checker-test-'));
  const file=join(folder,'state.json');
  try {
    expect((await loadCounters(file)).size).toBe(0);
    await saveCounters(file,new Map([['companies',{mismatches:7,lastMatch:100,streak:3,source:'not persisted'}]]));
    const restored=await loadCounters(file);
    expect(restored.get('companies')).toEqual({mismatches:7,lastMatch:100});
    expect(await readFile(file,'utf8')).not.toContain('not persisted');
    await writeFile(file,'corrupted');
    await expect(loadCounters(file)).rejects.toThrow();
  } finally {await rm(folder,{recursive:true,force:true});}
});
