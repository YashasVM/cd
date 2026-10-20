import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {findChromium} from './harness.mjs';
const url=process.argv[2]||'https://a.yash0.in/cd-bench/';
const browser=await chromium.launch({executablePath:await findChromium(),headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const response=await page.goto(url);assert.equal(response.status(),200);
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
 const acceptance=await (await page.request.get(new URL('isolated-gates.json',url).href)).json();
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
 await page.locator('#compare summary').click();assert.equal(await page.locator('#spreads tr').count(),3);
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflows at '+width);
 }
 for(const link of await page.locator('.links a').evaluateAll(links=>links.map(link=>link.href).filter(href=>new URL(href).origin===location.origin))){const result=await page.request.get(link);assert.equal(result.status(),200,link);}
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({url,scenarios:scenarios.length,combinations,browserComparisons:6,compressionComparisons:6,viewports:[1440,768,390],javascriptErrors:errors.length,passed:true}));
}finally{await browser.close()}
