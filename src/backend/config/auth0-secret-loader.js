/**
 * Auth0 Secret Loader
 *
 * Loads Auth0 credentials from AWS Secrets Manager into process.env when
 * AUTH0_SECRET_ID is set. Otherwise no-op (caller relies on .env).
 *
 * Resolves AWS credentials via the EC2 instance IAM role automatically —
 * no AWS access keys needed in env.
 *
 * The secret in AWS must be a JSON string of the shape:
 *   {
 *     "AUTH0_DOMAIN": "...",
 *     "AUTH0_AUDIENCE": "...",
 *     "AUTH0_CLIENT_ID": "...",
 *     "AUTH0_CLIENT_SECRET": "..."
 *   }
 */

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * Fetch the Auth0 secret from AWS Secrets Manager and merge it into
 * process.env. Throws if the secret is set but the fetch fails (loud
 * failure is preferable to silently falling back to stale or missing
 * Auth0 config).
 *
 * @returns {Promise<void>}
 */
async function loadAuth0Secret() {
  const secretId = process.env.AUTH0_SECRET_ID;
  if (!secretId) {
    // Local dev or any environment without AWS — caller relies on .env values.
    return;
  }

  const client = new SecretsManagerClient({ region: REGION });

  let response;
  try {
    response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  } catch (err) {
    throw new Error(`Failed to fetch Auth0 secret '${secretId}' from Secrets Manager (region ${REGION}): ${err.message}`);
  }

  if (!response.SecretString) {
    throw new Error(`Auth0 secret '${secretId}' has no SecretString value`);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch (err) {
    throw new Error(`Auth0 secret '${secretId}' is not valid JSON: ${err.message}`);
  }

  // Merge into process.env. Existing keys (e.g. from .env) get overridden
  // so AWS is the authoritative source whenever a secret ID is configured.
  Object.assign(process.env, parsed);
}

module.exports = { loadAuth0Secret };
