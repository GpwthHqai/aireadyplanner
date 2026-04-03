/**
 * Vercel Serverless API Route: Scorecard Results Handler
 *
 * Receives AI Readiness Scorecard results and:
 * 1. Creates/updates a contact in GoHighLevel via API (tagged for nurture workflow)
 * 2. Sends email notification to Vernon via Resend
 * 3. Sends lead confirmation email with score summary and diagnostic CTA
 *
 * REQUIRED ENVIRONMENT VARIABLES (set in Vercel Dashboard → Project Settings → Environment Variables):
 *
 * - GHL_API_KEY: Your GoHighLevel API key (Bearer token)
 *   Get from: GHL → Settings → Business Profile → API Keys
 *
 * - GHL_LOCATION_ID: Your GHL sub-account location ID
 *   Default: k5BVmKqYNLuQskIWpq1K (Stories That Lead Podcast sub-account)
 *
 * - RESEND_API_KEY: Your Resend API key
 *   Get from: https://resend.com/api-keys
 *   Free tier: 100 emails/day, 3,000/month
 *
 * - NOTIFICATION_EMAIL: Where to send score alerts (default: vernon@vernonross.com)
 *
 * - RESEND_FROM: Sender address (default: hello@aireadyplanner.com)
 *   Must be a verified domain in Resend
 */

export default async function handler(req, res) {
  // CORS headers
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://aireadyplanner.com',
    'https://www.aireadyplanner.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body;

  // Validate required fields
  const requiredFields = ['firstName', 'lastName', 'email', 'overallScore', 'dimensions'];
  const missingFields = requiredFields.filter(field => !payload[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({ error: 'Invalid input data', missingFields });
  }

  const requiredDimensions = ['strategy', 'tools', 'skills', 'content', 'governance'];
  const missingDimensions = requiredDimensions.filter(dim => payload.dimensions[dim] === undefined);

  if (missingDimensions.length > 0) {
    return res.status(400).json({ error: 'Invalid dimensions data', missingDimensions });
  }

  // Run all integrations in parallel, wait for all to complete before returning
  const results = await Promise.allSettled([
    sendToGHL(payload),
    sendResendEmail(payload),
    sendLeadEmail(payload)
  ]);

  // Log any failures
  const labels = ['GHL', 'Resend notification', 'Lead email'];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`${labels[i]} error:`, result.reason?.message || result.reason);
    }
  });

  return res.status(200).json({ success: true });
}

/**
 * Create or update contact in GoHighLevel
 */
async function sendToGHL(payload) {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID || 'k5BVmKqYNLuQskIWpq1K';

  if (!apiKey) {
    console.warn('GHL_API_KEY not configured — skipping GHL');
    return;
  }

  const contactPayload = {
    locationId,
    firstName: payload.firstName,
    lastName: payload.lastName,
    email: payload.email,
    companyName: payload.company || '',
    tags: ['scorecard-completed', 'ai-readiness-diagnostic', 'scorecard-nurture'],
    customFields: [
      { key: 'team_size', field_value: payload.teamSize || '' },
      { key: 'ai_readiness_score', field_value: String(payload.overallScore) },
      { key: 'ai_maturity_level', field_value: payload.maturityLevel || '' },
      { key: 'strategy_score', field_value: String(payload.dimensions.strategy) },
      { key: 'tools_score', field_value: String(payload.dimensions.tools) },
      { key: 'skills_score', field_value: String(payload.dimensions.skills) },
      { key: 'content_score', field_value: String(payload.dimensions.content) },
      { key: 'governance_score', field_value: String(payload.dimensions.governance) },
      { key: 'top_insights', field_value: payload.smartInsights ? payload.smartInsights.join('; ') : '' },
      { key: 'scorecard_completed', field_value: payload.timestamp || new Date().toISOString() }
    ]
  };

  // Use GHL v2 contacts/upsert endpoint — creates if new, updates if email exists
  const response = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Version': '2021-07-28'
    },
    body: JSON.stringify(contactPayload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GHL API ${response.status}: ${body}`);
  }

  console.log('GHL contact created/updated');
}

/**
 * Send email notification via Resend
 */
async function sendResendEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFICATION_EMAIL || 'vernon@vernonross.com';
  const fromEmail = process.env.RESEND_FROM || 'hello@aireadyplanner.com';

  if (!apiKey) {
    console.warn('RESEND_API_KEY not configured — logging scorecard instead:');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const dims = payload.dimensions;
  const insights = payload.smartInsights && payload.smartInsights.length > 0
    ? payload.smartInsights.map(i => `• ${i}`).join('\n')
    : 'None generated';

  // Build a clean HTML email
  const html = `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #0A1628; padding: 24px 32px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #D4AF55; margin: 0; font-size: 20px;">New Scorecard Completed</h1>
      </div>
      <div style="background: #f8f9fa; padding: 32px; border-radius: 0 0 8px 8px;">
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <tr>
            <td style="padding: 8px 0; font-weight: 600; color: #0A1628;">Name</td>
            <td style="padding: 8px 0;">${payload.firstName} ${payload.lastName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600; color: #0A1628;">Email</td>
            <td style="padding: 8px 0;"><a href="mailto:${payload.email}">${payload.email}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600; color: #0A1628;">Company</td>
            <td style="padding: 8px 0;">${payload.company || 'Not provided'}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600; color: #0A1628;">Team Size</td>
            <td style="padding: 8px 0;">${payload.teamSize || 'Not specified'}</td>
          </tr>
        </table>

        <div style="background: white; border-radius: 8px; padding: 24px; margin-bottom: 24px; border-left: 4px solid #D4AF55;">
          <div style="font-size: 48px; font-weight: 900; color: #0A1628; margin-bottom: 4px;">${payload.overallScore}/100</div>
          <div style="font-size: 14px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px;">${payload.maturityLevel || 'Unknown'}</div>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
          <tr style="border-bottom: 1px solid #e9ecef;">
            <td style="padding: 10px 0; font-weight: 600;">Strategy</td>
            <td style="padding: 10px 0; text-align: right; font-weight: 700; color: ${dims.strategy >= 60 ? '#065f46' : dims.strategy >= 40 ? '#92400e' : '#7f1d1d'};">${dims.strategy}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e9ecef;">
            <td style="padding: 10px 0; font-weight: 600;">Tools</td>
            <td style="padding: 10px 0; text-align: right; font-weight: 700; color: ${dims.tools >= 60 ? '#065f46' : dims.tools >= 40 ? '#92400e' : '#7f1d1d'};">${dims.tools}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e9ecef;">
            <td style="padding: 10px 0; font-weight: 600;">Skills</td>
            <td style="padding: 10px 0; text-align: right; font-weight: 700; color: ${dims.skills >= 60 ? '#065f46' : dims.skills >= 40 ? '#92400e' : '#7f1d1d'};">${dims.skills}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e9ecef;">
            <td style="padding: 10px 0; font-weight: 600;">Content</td>
            <td style="padding: 10px 0; text-align: right; font-weight: 700; color: ${dims.content >= 60 ? '#065f46' : dims.content >= 40 ? '#92400e' : '#7f1d1d'};">${dims.content}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; font-weight: 600;">Governance</td>
            <td style="padding: 10px 0; text-align: right; font-weight: 700; color: ${dims.governance >= 60 ? '#065f46' : dims.governance >= 40 ? '#92400e' : '#7f1d1d'};">${dims.governance}</td>
          </tr>
        </table>

        <div style="background: white; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <div style="font-weight: 600; margin-bottom: 8px; color: #0A1628;">Key Insights:</div>
          <div style="white-space: pre-line; color: #6B7280; font-size: 14px;">${insights}</div>
        </div>

        <div style="text-align: center; padding-top: 16px;">
          <a href="https://bookme.name/vernon/lite/ai-readiness-diagnostic-discovery-call"
             style="display: inline-block; background: #D4AF55; color: #0A1628; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">
            View in GHL
          </a>
        </div>
      </div>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: `🎯 Scorecard: ${payload.firstName} ${payload.lastName} (${payload.company || 'N/A'}) — ${payload.overallScore}/100`,
      html
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API ${response.status}: ${body}`);
  }

  console.log('Resend notification email sent');
}

/**
 * Send lead their score summary with diagnostic CTA
 */
async function sendLeadEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM || 'hello@aireadyplanner.com';

  if (!apiKey) {
    console.warn('RESEND_API_KEY not configured, skipping lead email');
    return;
  }

  const dims = payload.dimensions;
  const score = payload.overallScore;
  const level = payload.maturityLevel || 'Unknown';
  const insights = payload.smartInsights && payload.smartInsights.length > 0
    ? payload.smartInsights.map(i => `<li style="margin-bottom: 8px; color: #4a4a6a;">${i}</li>`).join('')
    : '';

  function scoreColor(s) {
    if (s >= 60) return '#065f46';
    if (s >= 40) return '#92400e';
    return '#7f1d1d';
  }

  function scoreBar(s) {
    return `<div style="background: #e9ecef; border-radius: 4px; height: 8px; width: 100%; margin-top: 4px;">
      <div style="background: ${s >= 60 ? '#D4AF55' : s >= 40 ? '#92400e' : '#7f1d1d'}; border-radius: 4px; height: 8px; width: ${s}%;"></div>
    </div>`;
  }

  const html = `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: #0A1628; padding: 32px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: #D4AF55; margin: 0 0 8px 0; font-size: 24px;">Your AI Readiness Results</h1>
        <p style="color: rgba(255,255,255,0.7); margin: 0; font-size: 14px;">AI-Ready Comms Team Scorecard</p>
      </div>

      <div style="padding: 32px; background: #f8f9fc;">
        <p style="color: #1a1a2e; font-size: 16px; margin: 0 0 24px 0;">Hi ${payload.firstName},</p>
        <p style="color: #4a4a6a; font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">Thanks for completing the AI Readiness Scorecard. Here's a summary of where your team stands.</p>

        <div style="background: white; border-radius: 12px; padding: 32px; text-align: center; margin-bottom: 24px; border: 1px solid #e9ecef;">
          <div style="font-size: 56px; font-weight: 900; color: #0A1628; margin-bottom: 4px;">${score}</div>
          <div style="font-size: 13px; color: #6B7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">out of 100</div>
          <div style="font-size: 18px; font-weight: 600; color: #D4AF55;">${level}</div>
        </div>

        <div style="background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid #e9ecef;">
          <h3 style="color: #0A1628; margin: 0 0 16px 0; font-size: 16px;">Dimension Scores</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #1a1a2e; font-weight: 500;">Strategy</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 700; color: ${scoreColor(dims.strategy)};">${dims.strategy}</td>
            </tr>
            <tr><td colspan="2">${scoreBar(dims.strategy)}</td></tr>
            <tr>
              <td style="padding: 8px 0; color: #1a1a2e; font-weight: 500;">Tools & Technology</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 700; color: ${scoreColor(dims.tools)};">${dims.tools}</td>
            </tr>
            <tr><td colspan="2">${scoreBar(dims.tools)}</td></tr>
            <tr>
              <td style="padding: 8px 0; color: #1a1a2e; font-weight: 500;">Team Skills</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 700; color: ${scoreColor(dims.skills)};">${dims.skills}</td>
            </tr>
            <tr><td colspan="2">${scoreBar(dims.skills)}</td></tr>
            <tr>
              <td style="padding: 8px 0; color: #1a1a2e; font-weight: 500;">Content & Workflow</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 700; color: ${scoreColor(dims.content)};">${dims.content}</td>
            </tr>
            <tr><td colspan="2">${scoreBar(dims.content)}</td></tr>
            <tr>
              <td style="padding: 8px 0; color: #1a1a2e; font-weight: 500;">Governance</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 700; color: ${scoreColor(dims.governance)};">${dims.governance}</td>
            </tr>
            <tr><td colspan="2">${scoreBar(dims.governance)}</td></tr>
          </table>
        </div>

        ${insights ? `
        <div style="background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid #e9ecef;">
          <h3 style="color: #0A1628; margin: 0 0 12px 0; font-size: 16px;">Key Insights</h3>
          <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
            ${insights}
          </ul>
        </div>
        ` : ''}

        <div style="background: #0A1628; border-radius: 12px; padding: 32px; text-align: center; margin-bottom: 24px;">
          <h3 style="color: white; margin: 0 0 12px 0; font-size: 18px;">Ready for the Full Picture?</h3>
          <p style="color: rgba(255,255,255,0.8); font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">The scorecard gives you a starting point. The AI Readiness Diagnostic is a 2-hour guided session that maps your workflows, audits your technology, and delivers a concrete implementation roadmap.</p>
          <a href="https://bookme.name/vernon/lite/ai-readiness-diagnostic-discovery-call"
             style="display: inline-block; background: #D4AF55; color: #0A1628; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">
            Schedule Your Diagnostic
          </a>
        </div>

        <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
          This email was sent by AI-Ready Comms Team Scorecard at aireadyplanner.com
        </p>
      </div>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: `AI Readiness Scorecard <${fromEmail}>`,
      to: [payload.email],
      subject: `Your AI Readiness Score: ${score}/100 - ${level}`,
      html
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend lead email ${response.status}: ${body}`);
  }

  console.log('Lead confirmation email sent to', payload.email);
}
