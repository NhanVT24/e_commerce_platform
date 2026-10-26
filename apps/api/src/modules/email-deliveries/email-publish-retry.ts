import { emailConfig } from "../../config/email-config.js";
import { emailPublishRetryAt } from "./domain/retry-policy.js";
export function nextEmailPublishRetryAt(attempt:number,nowMs=Date.now(),random=Math.random){return emailPublishRetryAt(attempt,{baseSeconds:emailConfig.EMAIL_EVENT_PUBLISH_RETRY_BASE_SECONDS,maxSeconds:emailConfig.EMAIL_EVENT_PUBLISH_RETRY_MAX_SECONDS},nowMs,random);}
