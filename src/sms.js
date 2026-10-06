'use strict';

/**
 * Sends login OTPs by SMS.
 *
 * With MSG91_AUTH_KEY and MSG91_TEMPLATE_ID set, OTPs go out through MSG91
 * (a common Indian SMS gateway; the template must be DLT-approved).
 * Without them the app runs in demo mode: the OTP is logged and returned to
 * the client so the flow can be tested without an SMS provider.
 */
function createSmsSender(env = process.env) {
  const authKey = env.MSG91_AUTH_KEY;
  const templateId = env.MSG91_TEMPLATE_ID;

  if (!authKey || !templateId) {
    return {
      demo: true,
      async sendOtp(mobile, otp) {
        console.log(`[demo OTP] ${mobile}: ${otp}`);
      },
    };
  }

  return {
    demo: false,
    async sendOtp(mobile, otp) {
      const url = new URL('https://control.msg91.com/api/v5/otp');
      url.searchParams.set('template_id', templateId);
      url.searchParams.set('mobile', `91${mobile}`);
      url.searchParams.set('otp', otp);
      const res = await fetch(url, { method: 'POST', headers: { authkey: authKey } });
      if (!res.ok) throw new Error(`MSG91 responded ${res.status}`);
    },
  };
}

module.exports = { createSmsSender };
