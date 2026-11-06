import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {findChromium} from './harness.mjs';
const url=process.argv[2]||'https://a.yash0.in/cd-bench/';
const browser=await chromium.launch({executablePath:await findChromium(),headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const response=await page.goto(url);assert.equal(response.status(),200);
 const disclosures=page.locator('details.report-group');
 assert.equal(await disclosures.count(),4);assert.equal(await page.locator('details.report-group[open]').count(),0);
 const browserSummary=await (await page.request.get(new URL('browser-matching-browser-summary.json',url).href)).json();
 for(const route of ['relay','direct']){
  await page.locator('#overview-route').selectOption(route);
  const panel=page.locator('[data-overview-route="'+route+'"]');assert.equal(await panel.isVisible(),true);
  for(const [index,direction] of ['browser-cli','cli-browser'].entries()){
   const result=browserSummary.cases.find(row=>row.name===direction+'/'+route).metrics.durableMs;
   const card=panel.locator('article').nth(index);
   assert.equal(await card.locator('.result').textContent(),'CD is '+result.ratio.toFixed(2)+'× faster');
   assert.deepEqual(await card.locator('.mini-row b').allTextContents(),[result.cdMs,result.crocMs].map(value=>(value/1000).toFixed(2)+' s'));
  }
 }
 await page.locator('#overview-route').selectOption('relay');
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overview overflows at '+width);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight)<1500,'overview is too long at '+width);
  await page.screenshot({path:'/tmp/cd-bench-compact-'+width+'.png',fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});
 for(const item of await disclosures.all()){await item.locator(':scope > summary').click();assert.equal(await item.getAttribute('open'),'');}
 await page.locator('#chart .chart-row').first().waitFor();
 const scenarios=await page.locator('#scenario option').evaluateAll(options=>options.map(option=>option.value));
 const metrics=await page.locator('#metric option').evaluateAll(options=>options.map(option=>option.value));
 let combinations=0;
 for(const scenario of scenarios)for(const metric of metrics){
  await page.locator('#scenario').selectOption(scenario);await page.locator('#metric').selectOption(metric);
  assert.equal(await page.locator('#chart .chart-row').count(),3);
  const expected=await page.evaluate(({scenario,metric})=>{
   const current=data.scenarios.find(s=>s.id===scenario);return {cd:current.tools.cd[metric],croc:Math.min(current.tools.croc[metric],current.tools['croc-no-compress'][metric])};
  },{scenario,metric});
  const format=n=>n.toLocaleString('en-US',{maximumFractionDigits:1})+' ms';
  assert.equal(await page.locator('#cd-kpi').textContent(),format(expected.cd));
  assert.equal(await page.locator('#croc-kpi').textContent(),format(expected.croc));
  combinations++;
 }
 const acceptance=await (await page.request.get(new URL('final-gates.json',url).href)).json();
 assert.equal(acceptance.complete,true);assert.equal(acceptance.achieved,false);
 assert.equal(await page.locator('#browser-results tr').count(),6);
 for(let index=0;index<acceptance.browserCases.length;index++){
  const result=acceptance.browserCases[index].metrics.durableMs;
  const cells=await page.locator('#browser-results tr').nth(index).locator('td').allTextContents();
  const format=n=>n.toLocaleString('en-US',{maximumFractionDigits:1});
  assert.equal(cells[1],format(result.cdMs));assert.equal(cells[2],format(result.crocMs));assert.equal(cells[3],result.ratio.toFixed(2)+'×');assert.equal(cells[4],'7 / 7');
 }
 const compressionReports=await Promise.all(['compression-before-browser.json','compression-after-browser.json'].map(async name=>(await page.request.get(new URL(name,url).href)).json()));
 assert.equal(await page.locator('#compression-results tr').count(),6);
 let rowIndex=0;
 for(const direction of ['browser-browser','browser-cli','cli-browser'])for(const route of ['direct','relay']){
  const groups=compressionReports.map((report,index)=>{
   assert.ok(report.finishedAt&&!report.error);const rows=report.rows.filter(row=>row.direction===direction&&row.route===route);
   assert.equal(rows.length,7);assert.ok(rows.every(row=>row.ok));
   for(const row of rows)for(const stats of [row.senderStats,row.receiverStats].filter(Boolean))assert.ok(stats.webSocketExtensions.length>0&&stats.webSocketExtensions.every(value=>index===0?value.includes('permessage-deflate'):value===''));
   return rows.map(row=>row.durableMs).sort((a,b)=>a-b)[3];
  });
  const cells=await page.locator('#compression-results tr').nth(rowIndex++).locator('td').allTextContents();
  assert.equal(cells[1],groups[0].toLocaleString('en-US',{maximumFractionDigits:1}));assert.equal(cells[2],groups[1].toLocaleString('en-US',{maximumFractionDigits:1}));assert.equal(cells[3],(groups[0]/groups[1]).toFixed(2)+'×');assert.equal(cells[4],'7 / 7');
 }
 const readReports=await Promise.all(['read-block-before-browser.json','read-block-after-browser.json'].map(async name=>(await page.request.get(new URL(name,url).href)).json()));
 assert.equal(await page.locator('#read-block-results tr').count(),2);
 for(const [index,direction] of ['browser-browser','browser-cli'].entries()){
  const medians=readReports.map(report=>{assert.ok(report.finishedAt&&!report.error);const rows=report.rows.filter(row=>row.direction===direction);assert.equal(rows.length,7);assert.ok(rows.every(row=>row.ok));return rows.map(row=>row.durableMs).sort((a,b)=>a-b)[3]});
  const cells=await page.locator('#read-block-results tr').nth(index).locator('td').allTextContents();
  assert.equal(cells[1],medians[0].toLocaleString('en-US',{maximumFractionDigits:1}));assert.equal(cells[2],medians[1].toLocaleString('en-US',{maximumFractionDigits:1}));assert.equal(cells[3],(medians[0]/medians[1]).toFixed(2)+'×');
 }
 const scheduling=await (await page.request.get(new URL('relay-scheduling-summary.json',url).href)).json();
 assert.equal(scheduling.productionChangeRetained,false);assert.equal(scheduling.rows.length,4);assert.equal(await page.locator('#relay-scheduling-results tr').count(),4);
 for(const [index,row] of scheduling.rows.entries()){
  const raw=await (await page.request.get(new URL(row.file,url).href)).json();assert.ok(raw.finishedAt&&!raw.error);assert.equal(raw.rows.length,14);
  const medians=['before','after'].map(variant=>{const rows=raw.rows.filter(r=>r.variant===variant);assert.equal(rows.length,7);assert.ok(rows.every(r=>r.ok&&r.bytes===67108864&&/^[a-f0-9]{64}$/.test(r.sha256)));return rows.map(r=>r.durableMs).sort((a,b)=>a-b)[3]});
  assert.equal(row.beforeMs,medians[0]);assert.equal(row.afterMs,medians[1]);assert.equal(row.ratio,medians[0]/medians[1]);
  const cells=await page.locator('#relay-scheduling-results tr').nth(index).locator('td').allTextContents();const format=n=>n.toLocaleString('en-US',{maximumFractionDigits:1});assert.equal(cells[1],format(row.beforeMs));assert.equal(cells[2],format(row.afterMs));assert.equal(cells[3],row.ratio.toFixed(2)+'×');
 }
 const rejected=await (await page.request.get(new URL('rejected-dispatch-summary.json',url).href)).json();
 assert.equal(rejected.productionChangeRetained,false);assert.equal(await page.locator('#rejected-results tr').count(),3);
 for(const [index,result] of rejected.rows.entries()){
  const cells=await page.locator('#rejected-results tr').nth(index).locator('td').allTextContents();
  assert.equal(cells[1],result.beforeMs.toLocaleString('en-US',{maximumFractionDigits:1}));assert.equal(cells[2],result.afterMs.toLocaleString('en-US',{maximumFractionDigits:1}));assert.equal(cells[3],result.ratio.toFixed(2)+'×');
 }
 const framing=await (await page.request.get(new URL('direct-framing-paired.json',url).href)).json();
 assert.ok(framing.finishedAt&&!framing.error);assert.equal(framing.rows.length,14);
 for(const [index,variant] of ['before','after'].entries()){
  const rows=framing.rows.filter(row=>row.variant===variant);assert.equal(rows.length,7);assert.ok(rows.every(row=>row.ok));
  const median=rows.map(row=>row.durableMs).sort((a,b)=>a-b)[3];assert.equal(await page.locator('#direct-framing-results tr').nth(index).locator('td').nth(1).textContent(),median.toLocaleString('en-US',{maximumFractionDigits:1}));
 }
 const hardware=await (await page.request.get(new URL('lan-hardware-limit.json',url).href)).json();
 assert.equal(hardware.speedMbps,100);assert.equal(hardware.hardwareTargetPossible,false);assert.ok(hardware.idealMaximumSpeedup<1.5);assert.ok(hardware.idealLineRateMs>hardware.requiredDurationMs);
 for(const [index,value] of [hardware.crocDurableMs,hardware.idealLineRateMs,hardware.requiredDurationMs].entries())assert.equal(await page.locator('#hardware-values tr').nth(index).locator('td').nth(1).textContent(),value.toLocaleString('en-US',{maximumFractionDigits:1}));
 await page.locator('#compare summary').click();assert.equal(await page.locator('#spreads tr').count(),3);
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflows at '+width);
 }
 for(const link of await page.locator('.links a').evaluateAll(links=>links.map(link=>link.href).filter(href=>new URL(href).origin===location.origin))){const result=await page.request.get(link);assert.equal(result.status(),200,link);}
 const iteration=await (await page.request.get(new URL('ponytail-iteration.json',url).href)).json();
 const paired=await (await page.request.get(new URL('ponytail-tcp-reuse-steady.json',url).href)).json();
 assert.equal(iteration.goalAchieved,false);assert.ok(iteration.codeSize.lineDelta<0&&iteration.codeSize.byteDelta<0);
 assert.equal(paired.contended,false);assert.equal(paired.rows.length,42);assert.ok(paired.rows.every(row=>row.ok&&row.sha256));
 assert.equal(await page.locator('#ponytail-results tr').count(),4);
 for(const [index,result] of iteration.rows.entries()){
  const med=(variant,tool)=>paired.rows.filter(row=>row.variant===variant&&row.tool===tool).map(row=>row[result.metric]).sort((a,b)=>a-b)[3];
  assert.equal(result.before.median,med('before','cd'));assert.equal(result.after.median,med('after','cd'));
  assert.equal(result.crocMs,Math.min(med('after','croc'),med('after','croc-no-compress')));
  const cells=await page.locator('#ponytail-results tr').nth(index).locator('td').allTextContents();
  const format=value=>value.toLocaleString('en-US',{maximumFractionDigits:1})+' ms';
  assert.equal(cells[1],format(result.before.median));assert.equal(cells[2],format(result.after.median));assert.equal(cells[3],format(result.crocMs));
 }
 const matching=await (await page.request.get(new URL('browser-matching-browser-summary.json',url).href)).json();
 const matchingRaw=await (await page.request.get(new URL('browser-matching-browser-paired.json',url).href)).json();
 assert.equal(matching.complete,true);assert.equal(matchingRaw.rows.length,63);assert.equal(matchingRaw.contended,false);
 assert.ok(matchingRaw.rows.every(row=>row.ok&&row.bytes===67108864&&/^[a-f0-9]{64}$/.test(row.sha256)));
 assert.equal(matchingRaw.metadata.cd.chromium,matchingRaw.metadata['croc-browser'].chromium);
 for(const metric of ['readyMs','receiverMs','durableMs','totalMs']){
  await page.locator('#matching-metric').selectOption(metric);
  assert.equal(await page.locator('#matching-results tr').count(),6);assert.equal(await page.locator('#matching-chart>div').count(),6);
  for(const [index,entry] of matching.cases.entries()){
   const [direction,route]=entry.name.split('/');
   const med=tool=>{const rows=matchingRaw.rows.filter(row=>row.tool===tool&&row.direction===direction&&row.route===(tool==='cd'?route:'relay'));assert.equal(rows.length,7);return rows.map(row=>row[metric]).sort((a,b)=>a-b)[3]};
   const cd=med('cd'),croc=med('croc-browser'),result=entry.metrics[metric];
   assert.equal(result.cdMs,cd);assert.equal(result.crocMs,croc);assert.equal(result.ratio,croc/cd);
   const cells=await page.locator('#matching-results tr').nth(index).locator('td').allTextContents();
   assert.ok(cells[1].startsWith(cd.toLocaleString('en-US',{maximumFractionDigits:1})+' ms'));
   assert.ok(cells[2].startsWith(croc.toLocaleString('en-US',{maximumFractionDigits:1})+' ms'));
   assert.equal(cells[3],(croc/cd).toFixed(2)+'×');assert.equal(cells[4],croc/cd>=1.5?'pass':'miss');
  }
 }
 assert.equal(await page.locator('#source-view-results tr').count(),3);
 for(const [index,entry] of matching.sourceViews.entries()){
  const trial=await (await page.request.get(new URL('browser-'+entry.file,url).href)).json();
  assert.ok(trial.finishedAt&&!trial.error);assert.equal(trial.rows.length,14);assert.ok(trial.rows.every(row=>row.ok));
  const med=variant=>trial.rows.filter(row=>row.variant===variant).map(row=>row.durableMs).sort((a,b)=>a-b)[3];
  assert.equal(entry.beforeMs,med('before'));assert.equal(entry.afterMs,med('after'));
  const cells=await page.locator('#source-view-results tr').nth(index).locator('td').allTextContents();
  assert.equal(cells[1],entry.beforeMs.toLocaleString('en-US',{maximumFractionDigits:1})+' ms');
  assert.equal(cells[2],entry.afterMs.toLocaleString('en-US',{maximumFractionDigits:1})+' ms');
  assert.equal(cells[3],(entry.beforeMs/entry.afterMs).toFixed(2)+'×');
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({url,scenarios:scenarios.length,combinations,browserComparisons:6,compressionComparisons:6,readBlockComparisons:2,rejectedComparisons:3,directFramingComparisons:2,hardwareLimitChecked:true,relaySchedulingComparisons:4,matchingBrowserComparisons:24,sourceViewComparisons:3,viewports:[1440,768,390],javascriptErrors:errors.length,passed:true}));
}finally{await browser.close()}
