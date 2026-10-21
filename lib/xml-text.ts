export const xmlSafeText=(value:unknown)=>{
  let result='';
  for(const char of String(value)) {
    const code=char.codePointAt(0)!;
    if(code===0x09||code===0x0a||code===0x0d||(code>=0x20&&code<=0xd7ff)||(code>=0xe000&&code<=0xfffd)||(code>=0x10000&&code<=0x10ffff))result+=char;
  }
  return result;
};
