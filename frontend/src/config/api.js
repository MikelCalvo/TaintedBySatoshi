/**
 * API configuration
 * Centralizes all API-related configuration in one place
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Request timeout in milliseconds
const REQUEST_TIMEOUT = 30000;

// Health check timeout (shorter)
const HEALTH_CHECK_TIMEOUT = 3000;

/**
 * Creates an AbortSignal with timeout
 */
function createTimeoutSignal(timeout = REQUEST_TIMEOUT) {
  return AbortSignal.timeout(timeout);
}

/**
 * Fetches data from the API with timeout and error handling
 */
async function fetchWithTimeout(endpoint, options = {}) {
  const timeout = options.timeout || REQUEST_TIMEOUT;
  const signal = createTimeoutSignal(timeout);

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = new Error(response.statusText || "Request failed");
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * Checks if the API is healthy
 */
async function checkHealth() {
  return fetchWithTimeout("/api/health", {
    timeout: HEALTH_CHECK_TIMEOUT,
  });
}

/**
 * Checks a Bitcoin address connection
 */
async function checkAddress(address) {
  // Validate address format before making request
  if (!address || typeof address !== "string") {
    throw new Error("Invalid address");
  }

  // Basic sanitization - remove any whitespace
  const sanitizedAddress = address.trim();

  // Basic format check
  if (
    !sanitizedAddress.startsWith("1") &&
    !sanitizedAddress.startsWith("3") &&
    !sanitizedAddress.toLowerCase().startsWith("bc1")
  ) {
    throw new Error("Invalid Bitcoin address format");
  }

  return fetchWithTimeout(`/api/check/${encodeURIComponent(sanitizedAddress)}`);
}

module.exports = {
  API_URL,
  REQUEST_TIMEOUT,
  HEALTH_CHECK_TIMEOUT,
  fetchWithTimeout,
  checkHealth,
  checkAddress,
};
