package syncd

import (
	"encoding/json"
	"time"
)

func unmarshalJSON(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

func nowUnix() int64 {
	return time.Now().Unix()
}
