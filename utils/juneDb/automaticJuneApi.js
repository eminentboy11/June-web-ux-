'use strict';
const crypto=require('node:crypto');
const { JuneApiStore, JuneApiError, INTERNAL_JUNE_API_URL }=require('./juneApiAdapter');
const { deriveIdentity,validateSecret,AUDIENCE,PURPOSE }=require('./installationIdentity');
const NAMESPACE='june-db-v1';
const SAFE_CODES=new Set(['challenge_invalid','challenge_used','challenge_expired','proof_invalid','installation_revoked',
  'automatic_registration_disabled','automatic_capacity_reached','automatic_storage_quota','identity_rate_limited',
  'version_conflict','idempotency_conflict','snapshot_changed','not_found','unauthorized','invalid_request','invalid_resource','invalid_key']);
function safeError(error) {
  const code=SAFE_CODES.has(error?.code)?error.code:'automatic_api_unavailable';
  const status=Number.isInteger(error?.status)?error.status:0;
  return new JuneApiError(`June automatic database request failed (${code})`,{status,code});
}
class AutomaticJuneApiStore extends JuneApiStore {
  #secret; #identity; #transport; #authenticating; #expiresAt=0; #closed=false;
  constructor({secret,fetchImpl=globalThis.fetch,requestTimeoutMs=15000}={}) {
    validateSecret(secret);
    super({token:'automatic-not-yet-authenticated',baseUrl:INTERNAL_JUNE_API_URL,fetchImpl,requestTimeoutMs});
    delete this.token;
    this.#secret=secret;
    // Test injection is a function argument, NOT a user environment URL. Production
    // always targets the built-in HTTPS endpoint and refuses redirects.
    this.fetchImpl=(url,options)=>fetchImpl(url,{...options,redirect:'error'});
  }
  async #post(path,body) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.requestTimeoutMs);
    try {
      const response=await this.fetchImpl(`${INTERNAL_JUNE_API_URL}${path}`,{
        method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify(body),signal:controller.signal,
      });
      if(response.status>=300 && response.status<400) throw new Error('Redirect rejected');
      const text=await response.text();
      if(text.length>8192)throw new Error('Invalid identity response size');
      const payload=JSON.parse(text);
      if(!response.ok)throw new JuneApiError('Identity request rejected',{status:response.status,code:payload?.error});
      return payload;
    } finally {clearTimeout(timer);}
  }
  async #authenticate() {
    if(this.#closed)throw safeError();
    if(this.#authenticating)return this.#authenticating;
    this.#authenticating=(async()=>{
      if(!this.#identity){this.#identity=await deriveIdentity(this.#secret);this.#secret=undefined;}
      for(let attempt=0;attempt<3;attempt++) {
        try {
          const c=await this.#post('/v1/identity/challenge',{publicKey:this.#identity.publicKey});
          if(c.version!==1||c.audience!==AUDIENCE||c.purpose!==PURPOSE||c.publicKey!==this.#identity.publicKey||
            !/^[a-f0-9-]{36}$/.test(c.challengeId||'')||!/^[A-Za-z0-9_-]{43}$/.test(c.nonce||'')||!Number.isSafeInteger(c.expiresAt)) {
            throw new Error('Invalid challenge context');
          }
          const r=await this.#post('/v1/identity/authenticate',{challengeId:c.challengeId,signature:this.#identity.sign(c)});
          if(!/^june_x_[a-f0-9]{24}$/.test(r?.installation?.dbId||'')||r.installation.namespace!==NAMESPACE||
            !/^[A-Za-z0-9_-]{43}$/.test(r?.session?.token||'')||!Number.isSafeInteger(r.session.expiresAt))throw new Error('Invalid session response');
          if(this.#closed)throw safeError();
          if(this.dbId&&this.dbId!==r.installation.dbId)throw new Error('Identity changed unexpectedly');
          this.dbId=r.installation.dbId;
          this.#expiresAt=r.session.expiresAt;
          this.#transport=new JuneApiStore({token:r.session.token,dbId:this.dbId,baseUrl:INTERNAL_JUNE_API_URL,
            fetchImpl:this.fetchImpl,requestTimeoutMs:this.requestTimeoutMs});
          return;
        } catch(cause) {
          const error=safeError(cause);
          const freshChallenge=['challenge_invalid','challenge_used','challenge_expired'].includes(error.code);
          if(attempt===2||(!error.retryable&&!freshChallenge))throw error;
          await new Promise(resolve=>setTimeout(resolve,100*(2**attempt)));
          // Never replay a successful proof after a lost response. Start with a
          // fresh challenge; the server's unique identity binding reuses the tenant.
        }
      }
    })().finally(()=>{this.#authenticating=null;});
    return this.#authenticating;
  }
  async request(path,options={}) {
    // Keep logical mutation ID stable even across token refresh after HTTP 401.
    const opts={...options};
    if(opts.method&&opts.method!=='GET'&&opts.method!=='HEAD'&&!opts.idempotencyKey)opts.idempotencyKey=crypto.randomUUID();
    try {
      if(!this.#transport||Date.now()>=this.#expiresAt-30000)await this.#authenticate();
      try {return await this.#transport.request(path,opts);}
      catch(error) {
        if(error.status!==401)throw error;
        this.#expiresAt=0;await this.#authenticate();
        return await this.#transport.request(path,opts);
      }
    } catch(error) {throw safeError(error);}
  }
  close(){this.#closed=true;this.#secret=undefined;this.#identity=null;this.#transport=null;this.#expiresAt=0;}
}
module.exports={AutomaticJuneApiStore,NAMESPACE};
