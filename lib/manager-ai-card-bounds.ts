// Check container sizes and literal field types before invoking a schema parser.
// Older schema engines can allocate an issue for every oversized invalid item.
export function cardRecord(value:unknown,allowed:readonly string[]):value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)return false;
  let count=0;
  for(const key in value){
    if(!Object.hasOwn(value,key))continue;
    if(++count>allowed.length||!allowed.includes(key))return false;
  }
  return true;
}
export const cardText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
export function cardTextList(value:unknown,maxItems:number,maxChars:number):value is string[] {
  if(!Array.isArray(value)||value.length>maxItems)return false;
  for(const item of value)if(!cardText(item,maxChars))return false;
  return true;
}
export function boundedPresentationInput(value:unknown) {
  if(!cardRecord(value,['title','layout','columns','rows'])||!cardText(value.title,32000)||
    typeof value.layout!=='string'||!['table','steps','facts'].includes(value.layout)||
    !cardTextList(value.columns,8,32000)||!value.columns.length||
    !Array.isArray(value.rows)||!value.rows.length||value.rows.length>24)return false;
  for(const row of value.rows)if(!cardTextList(row,8,360)||row.length!==value.columns.length)return false;
  return true;
}
