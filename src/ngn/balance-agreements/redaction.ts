/** NGN confirmation requests must never reach monitoring with their step-up token. */
export function redactNgnMonitoring<T>(event:T):T {
  const value=event as any;
  if(String(value?.request?.url??'').includes('/ngn/balance-agreements')) {
    value.request={...value.request,data:'[Filtered NGN confirmation]',headers:undefined,cookies:undefined};
  }
  return event;
}
