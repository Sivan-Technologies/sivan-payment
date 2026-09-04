import { signUserJwt } from '../src/auth/jwt.js';

async function test() {
  const userId = 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  const token = signUserJwt({ userId, email: 'sivantech@gmail.com' });

  console.log('Testing GET https://api-staging.sivantech.online/api/users/me/service-agreements with live token...');
  const res = await fetch('https://api-staging.sivantech.online/api/users/me/service-agreements', {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  console.log('HTTP Status:', res.status);
  const json = await res.json();
  console.log('Deals count returned by live API:', json.data?.deals?.length || 0);
  console.log('Full response:', JSON.stringify(json, null, 2));
}

test().catch(console.error);
