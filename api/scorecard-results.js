/**
 * Vercel Serverless API Route: Scorecard Results Handler
 *
 * This endpoint receives AI Readiness Scorecard results and forwards them to:
 * 1. GoHighLevel (GHL) for contact creation/update
 * 2. Email notification to Vernon Ross
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 * - GHL_WEBHOOK_URL: Your GoHighLevel webhook endpoint for contact creation
 *   Example: https://api.gohighlevel.com/v1/contacts
 *   Set in Vercel Dashboard → Project Settings → Environment Variables
 *
 * - EMAIL_WEBHOOK_URL: Webhook for sending email notifications
 *   Can be: Zapier webhook, Make webhook, or custom SMTP service
 *   Example: https://hooks.zapier.com/hooks/catch/xxxxx/yyyy/
 *   If not set, email notifications will be logged to console
 *
 * CORS: Allows requests from aireadyplanner.com and localhost
 */

export default async function handler(req, res) {
  // CORS headers
  const origin = req.headers.origin || '';
  const allowedOrigins = ['https://aireadyplanner.com', 'http://localhost:3000', 'http://localhost:5173'];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body;

  // Validation: Check required fields
  const requiredFields = ['firstName', 'lastName', 'email', 'overallScore', 'dimensions'];
  const missingFields = requiredFields.filter(field => !payload[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: 'Invalid input data',
      missingFields
    });
  }

  // Validate dimensions object has required score fields
  const requiredDimensions = ['strategy', 'tools', 'skills', 'content', 'governance'];
  const missingDimensions = requiredDimensions.filter(dim => payload.dimensions[dim] === undefined);

  if (missingDimensions.length > 0) {
    return res.status(400).json({
      error: 'Invalid dimensions data',
      missingDimensions
    });
  }

  // Extract and transform data for GHL
  const ghlPayload = {
    first_name: payload.firstName,
    last_name: payload.lastName,
    email: payload.email,
    company_name: payload.company || '',
    customField: {
      team_size: payload.teamSize || '',
      ai_readiness_score: payload.overallScore,
      ai_maturity_level: payload.maturityLevel || '',
      strategy_score: payload.dimensions.strategy,
      tools_score: payload.dimensions.tools,
      skills_score: payload.dimensions.skills,
      content_score: payload.dimensions.content,
      governance_score: payload.dimensions.governance,
      top_insights: payload.smartInsights ? payload.smartInsights.join('; ') : '',
      scorecard_completed: payload.timestamp || new Date().toISOString()
    },
    tags: ['scorecard-completed', 'ai-readiness-diagnostic']
  };

  // Prepare email body
  const emailBody = `Subject: New Scorecard: ${payload.firstName} ${payload.lastName} (${payload.company || 'N/A'}) - Score: ${payload.overallScore}/100

New AI Readiness Scorecard Completed

Name: ${payload.firstName} ${payload.lastName}
Email: ${payload.email}
Company: ${payload.company || 'N/A'}
Team Size: ${payload.teamSize || 'Not specified'}

Overall Score: ${payload.overallScore}/100 (${payload.maturityLevel || 'Unknown'})

Dimension Scores:
- Strategy: ${payload.dimensions.strategy}
- Tools: ${payload.dimensions.tools}
- Skills: ${payload.dimensions.skills}
- Content: ${payload.dimensions.content}
- Governance: ${payload.dimensions.governance}

Key Insights:
${payload.smartInsights && payload.smartInsights.length > 0
  ? payload.smartInsights.map(insight => `- ${insight}`).join('\n')
  : '- No insights provided'}

Completed: ${payload.timestamp || new Date().toISOString()}`;

  const emailPayload = {
    subject: `New Scorecard: ${payload.firstName} ${payload.lastName} (${payload.company || 'N/A'}) - Score: ${payload.overallScore}/100`,
    body: emailBody,
    to: 'vernon@aireadyplanner.com', // Update with correct email if needed
    scorecard: {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      company: payload.company,
      overallScore: payload.overallScore,
      maturityLevel: payload.maturityLevel,
      dimensions: payload.dimensions,
      timestamp: payload.timestamp
    }
  };

  // Fire-and-forget: Send to GHL
  sendToGHL(ghlPayload).catch(error => {
    console.error('GHL webhook error:', error.message);
    // Don't throw - this is fire-and-forget
  });

  // Fire-and-forget: Send email notification
  sendEmailNotification(emailPayload).catch(error => {
    console.error('Email webhook error:', error.message);
    // Don't throw - this is fire-and-forget
  });

  // Return success immediately to client
  return res.status(200).json({ success: true, message: 'Scorecard received' });
}

/**
 * Send scorecard data to GHL webhook
 */
async function sendToGHL(payload) {
  const webhookUrl = process.env.GHL_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('GHL_WEBHOOK_URL not configured - skipping GHL integration');
    return;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`GHL webhook returned ${response.status}: ${response.statusText}`);
  }

  console.log('Successfully sent scorecard to GHL');
}

/**
 * Send email notification via webhook or log to console
 */
async function sendEmailNotification(payload) {
  const webhookUrl = process.env.EMAIL_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log('EMAIL_WEBHOOK_URL not configured - logging email instead:');
    console.log(payload.body);
    return;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Email webhook returned ${response.status}: ${response.statusText}`);
  }

  console.log('Successfully sent email notification');
}
