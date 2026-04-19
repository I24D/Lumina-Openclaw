export interface User {
  id:         string;
  email:      string;
  created_at: string;
}

export interface TokenPair {
  access_token:  string;
  refresh_token: string;
}

export interface AuthResponse {
  user:          User;
  access_token:  string;
  refresh_token: string;
}

export interface JwtPayload {
  sub:   string;
  email: string;
  iat?:  number;
  exp?:  number;
}
