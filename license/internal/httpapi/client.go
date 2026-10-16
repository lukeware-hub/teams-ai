package httpapi

import (
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"time"
)

const TeamsAIKeyHash = "37de5504def906923e5bbfc479245bca88138d525df2df74e6d59aff60bff9d5"

const clientWindow = 5 * time.Minute

func clientOK(priv *rsa.PrivateKey, keyHash, header string, now time.Time) bool {
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil || priv == nil {
		return false
	}
	plain, err := rsa.DecryptOAEP(sha256.New(), nil, priv, raw, nil)
	if err != nil {
		return false
	}
	var body struct {
		K string `json:"k"`
		T int64  `json:"t"`
	}
	if json.Unmarshal(plain, &body) != nil {
		return false
	}
	sum := sha256.Sum256([]byte(body.K))
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(keyHash)) != 1 {
		return false
	}
	age := now.Sub(time.Unix(body.T, 0))
	return age <= clientWindow && age >= -clientWindow
}
