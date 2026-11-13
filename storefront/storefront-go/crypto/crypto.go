package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"log"

	"github.com/go-jose/go-jose/v4"
	"github.com/joho/godotenv"
)

var serverPrivateKey jose.JSONWebKey

func init() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, relying on OS environment variables")
	}
	if err := json.Unmarshal([]byte(os.Getenv("ECDH_PRIVATE_KEY_JWK")), &serverPrivateKey); err != nil {
		panic("invalid ECDH_PRIVATE_KEY_JWK: " + err.Error())
	}
}

func UnwrapKey(compactJWE string) ([]byte, error) {
	obj, err := jose.ParseEncrypted(compactJWE,
		[]jose.KeyAlgorithm{jose.ECDH_ES_A256KW},
		[]jose.ContentEncryption{jose.A256GCM})
	if err != nil {
		return nil, err
	}
	return obj.Decrypt(serverPrivateKey)
}

func DecryptValue(aesKey []byte, encoded string) (string, error) {
	combined, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(combined) < 28 {
		return "", errors.New("invalid ciphertext")
	}
	block, _ := aes.NewCipher(aesKey)
	gcm, _ := cipher.NewGCM(block)
	plaintext, err := gcm.Open(nil, combined[:12], combined[12:], nil)
	return string(plaintext), err
}

func EncryptValue(aesKey []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	gcm, _ := cipher.NewGCM(block)
	iv := make([]byte, 12)
	rand.Read(iv)
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	return base64.RawURLEncoding.EncodeToString(append(iv, sealed...)), nil
}