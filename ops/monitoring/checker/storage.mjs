import { readFile, writeFile, rename } from 'node:fs/promises';
import { ENTITIES } from './state.mjs';
export async function loadCounters(path) {
  let saved;
  try {saved=JSON.parse(await readFile(path,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return new Map();throw error;}
  const states=new Map();
  for(const entity of ENTITIES) {
    const row=saved[entity];
    if(!Number.isSafeInteger(row?.mismatches)||row.mismatches<0||!Number.isFinite(row.lastMatch)||row.lastMatch<0)throw new Error('Invalid checker state');
    states.set(entity,{mismatches:row.mismatches,lastMatch:row.lastMatch});
  }
  return states;
}
export async function saveCounters(path,states) {
  const data=Object.fromEntries(ENTITIES.map(entity=>{
    const s=states.get(entity)??{};
    return [entity,{mismatches:s.mismatches??0,lastMatch:s.lastMatch??0}];
  }));
  await writeFile(path+'.next',JSON.stringify(data),{mode:0o600});
  await rename(path+'.next',path);
}
