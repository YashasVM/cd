import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cases} from './bench-croc-matrix.mjs';
const tools=['cd','croc','croc-no-compress'];
const metrics=['readyMs','receiverMs','durableMs','totalMs'];
const requiredCases=['random-4k','random-1m','random-64m','random-256m','compressible-256m'];
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2};
function samples(rows,runs,bytes){
 const good=rows.filter(row=>row.ok&&row.bytes===bytes&&Number.isInteger(row.run)&&row.run>=0&&row.run<runs&&/^[a-f0-9]{64}$/.test(row.sha256||'')&&metrics.every(metric=>Number.isFinite(row[metric])&&row[metric]>0));
 const complete=Number.isSafeInteger(bytes)&&bytes>0&&Number.isInteger(runs)&&runs>0&&rows.length===runs&&good.length===runs&&new Set(good.map(row=>row.run)).size===runs;
 return {complete,runs:rows.length,verified:good.length,medians:complete?Object.fromEntries(metrics.map(metric=>[metric,median(good.map(row=>row[metric]))])):null};
}
function comparison(name,groups,threshold){
 const complete=tools.every(tool=>groups[tool]?.complete);
 const results=complete?Object.fromEntries(metrics.map(metric=>{
  const fasterCroc=Math.min(groups.croc.medians[metric],groups['croc-no-compress'].medians[metric]);
  const cd=groups.cd.medians[metric];return [metric,{cdMs:cd,crocMs:fasterCroc,ratio:fasterCroc/cd,pass:fasterCroc/cd>=threshold}];
 })):null;
 return {name,complete,groups,metrics:results,pass:complete&&Object.values(results).every(result=>result.pass)};
}
export function evaluateProf(native,browser,lan,{threshold=1.5}={}){
 if(!Number.isFinite(threshold)||threshold<=1)throw new RangeError('threshold must exceed one');
 const nativeCases=[];
 if(native?.options)for(const storage of native.options.storage)for(const route of native.options.routes)for(const name of native.options.cases){
  const rows=native.rows.filter(row=>row.storage===storage&&row.route===route&&row.case===name);
  const groups=Object.fromEntries(tools.map(tool=>[tool,samples(rows.filter(row=>row.tool===tool),native.options.runs,cases[name]?.bytes)]));
  nativeCases.push(comparison(storage+'/'+route+'/'+name,groups,threshold));
 }
 const browserCases=[];
 for(const direction of ['browser-browser','browser-cli','cli-browser'])for(const route of ['direct','relay']){
  const bytes=(browser?.mib||0)*1048576;
  const reference=nativeCases.find(entry=>entry.name==='tmpfs/'+(route==='direct'?'auto':'relay')+'/random-'+browser?.mib+'m');
  const rows=browser?.rows?.filter(row=>row.direction===direction&&row.route===route)||[];
  const cd=samples(rows,browser?.runs,bytes);
  browserCases.push({...comparison(direction+'/'+route,{cd,croc:reference?.groups.croc,'croc-no-compress':reference?.groups['croc-no-compress']},threshold),reference:reference?.name??null});
 }
 const lanGroups=Object.fromEntries(tools.map(tool=>[tool,samples(lan?.rows?.filter(row=>row.tool===tool)||[],lan?.options?.runs,(lan?.options?.mib||0)*1048576)]));
 const lanCase=comparison('physical-lan',lanGroups,threshold);
 const reports=[native,browser,lan];
 const scope=requiredCases.every(name=>native?.options?.cases.includes(name))
  &&['disk','tmpfs'].every(name=>native?.options?.storage.includes(name))
  &&['auto','relay'].every(name=>native?.options?.routes.includes(name))
  &&native.options.runs>=7&&browser?.runs>=7&&browser?.mib===64&&lan?.options?.runs>=3;
 const finished=reports.every(report=>report?.finishedAt&&!report.error&&!report.cleanupError);
 const all=[...nativeCases,...browserCases,lanCase];
 return {version:1,threshold,finished,scope,nativeCases,browserCases,lanCase,
  complete:finished&&scope&&all.every(entry=>entry.complete),
  achieved:finished&&scope&&all.every(entry=>entry.pass),
  note:'Browser CD is compared with native croc at the same payload size and RAM output. It is not a croc-browser test. Direct allowed includes successful relay completion before ICE opens. Readiness, native exit, durable completion and total time are separate gates. Actual route evidence and individual verification remain in raw reports.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [nativePath,browserPath,lanPath,output]=process.argv.slice(2);
 if(!nativePath||!browserPath||!lanPath||!output)throw new Error('Usage: node scripts/prof-gates.mjs native.json browser.json lan.json output.json');
 const reports=await Promise.all([nativePath,browserPath,lanPath].map(async path=>JSON.parse(await readFile(path,'utf8'))));
 const result=evaluateProf(...reports);await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({output,complete:result.complete,achieved:result.achieved,nativePasses:result.nativeCases.filter(row=>row.pass).length,browserPasses:result.browserCases.filter(row=>row.pass).length,lanPass:result.lanCase.pass}));
}
