/**
 * Facebook JavaScript SDK loader for Embedded Signup
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
 */

export interface FacebookSDK {
  init(params: {
    appId: string | undefined;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: FacebookLoginOptions
  ): void;
}

export interface FacebookLoginResponse {
  authResponse?: {
    code: string;
    accessToken?: string;
    expiresIn?: number;
  };
  status?: string;
}

export interface FacebookLoginOptions {
  config_id: string | undefined;
  auth_type?: "rerequest";
  response_type: string;
  override_default_response_type: boolean;
  /** WhatsApp Embedded Signup v4; products and version come from config_id. */
  extras?: {
    setup?: Record<string, unknown>;
    featureType?: "whatsapp_business_app_onboarding";
  };
}

export function createFacebookLoginCallback(
  handler: (response: FacebookLoginResponse) => Promise<void>,
  onError?: (error: unknown) => void
) {
  return function facebookLoginCallback(response: FacebookLoginResponse): void {
    void handler(response).catch(error => {
      onError?.(error);
    });
  };
}

let facebookSDKPromise: Promise<FacebookSDK> | null = null;

export const loadFacebookSDK = (): Promise<FacebookSDK> => {
  const existingSdk = window.FB;
  if (existingSdk) {
    console.log("Facebook SDK already loaded");
    return Promise.resolve(existingSdk);
  }

  if (facebookSDKPromise) {
    return facebookSDKPromise;
  }

  facebookSDKPromise = new Promise((resolve, reject) => {
    console.log("Loading Facebook SDK...");

    window.fbAsyncInit = function () {
      console.log("Facebook SDK initialized");
      const sdk = window.FB;
      if (!sdk) {
        facebookSDKPromise = null;
        reject(new Error("Facebook SDK loaded without exposing window.FB"));
        return;
      }

      sdk.init({
        appId: process.env.NEXT_PUBLIC_META_APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: "v25.0",
      });
      resolve(sdk);
    };

    const existingScript = document.getElementById("facebook-jssdk");
    if (existingScript) {
      existingScript.addEventListener("error", () => {
        facebookSDKPromise = null;
        reject(new Error("Facebook SDK script failed to load"));
      });
      return;
    }

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      facebookSDKPromise = null;
      reject(new Error("Facebook SDK script failed to load"));
    };
    document.body.appendChild(script);
  });

  return facebookSDKPromise;
};
