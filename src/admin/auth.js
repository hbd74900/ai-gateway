async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function hmacVerify(message, signature, secret) {
  const expected = await hmacSign(message, secret);
  return expected === signature;
}

export async function createToken(password) {
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24h
  const payload = JSON.stringify({ expires });
  const sig = await hmacSign(payload, password);
  return btoa(payload) + '.' + sig;
}

export async function verifyToken(token, password) {
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return false;
    const payload = atob(payloadB64);
    const valid = await hmacVerify(payload, sig, password);
    if (!valid) return false;
    const { expires } = JSON.parse(payload);
    return Date.now() < expires;
  } catch {
    return false;
  }
}

export async function handleLogin(request, env, store) {
  try {
    const { password } = await request.json();
    if (!password) {
      return jsonRes({ error: 'Password or API key is required' }, 400);
    }

    const adminPwd = env.ADMIN_PASSWORD;
    let authenticated = false;

    // 1. Try admin password
    if (adminPwd && password === adminPwd) {
      authenticated = true;
    }

    // 2. Try API key
    if (!authenticated && store) {
      const apiKeys = await store.getApiKeys();
      const found = apiKeys.find(k => k.key === password && k.enabled);
      if (found) {
        authenticated = true;
      }
    }

    if (!authenticated) {
      if (!adminPwd) {
        return jsonRes({ error: 'ADMIN_PASSWORD not configured and no matching API key found' }, 500);
      }
      return jsonRes({ error: 'Invalid password or API key' }, 401);
    }

    // Use ADMIN_PASSWORD as token signing secret; fallback to a derived secret from the input
    const secret = adminPwd || password;
    const token = await createToken(secret);
    return jsonRes({ token });
  } catch (err) {
    return jsonRes({ error: 'Invalid request' }, 400);
  }
}

export async function requireAuth(request, env, store) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const bearer = auth.slice(7);

  // 1. Try verifying as HMAC token (signed with ADMIN_PASSWORD)
  if (env.ADMIN_PASSWORD) {
    const valid = await verifyToken(bearer, env.ADMIN_PASSWORD);
    if (valid) return true;
  }

  // 2. Try as a direct API key
  if (store) {
    const apiKeys = await store.getApiKeys();
    const found = apiKeys.find(k => k.key === bearer && k.enabled);
    if (found) return true;
  }

  return false;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
