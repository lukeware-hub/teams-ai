package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const TTL = 12 * time.Hour

type claims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
}

func HashPassword(password string) (string, error) {
	hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hashed), nil
}

func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func Sign(secret []byte, subject string, exp time.Time) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims{Sub: subject, Exp: exp.Unix()})
	if err != nil {
		return "", err
	}
	body := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func Subject(secret []byte, token string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("unauthorized")
	}
	body := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errors.New("unauthorized")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(body))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", errors.New("unauthorized")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("unauthorized")
	}
	var parsed claims
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Sub == "" || parsed.Exp <= now.Unix() {
		return "", errors.New("unauthorized")
	}
	return parsed.Sub, nil
}
