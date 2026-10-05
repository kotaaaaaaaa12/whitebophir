package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

var mediaHost = regexp.MustCompile(`^[a-z0-9-]+\.googlevideo\.com$`)
var byteRange = regexp.MustCompile(`^bytes=[0-9]{1,15}-[0-9]{0,15}$`)
var directMediaHTTP = &http.Client{
	Transport: proxyHTTP.Transport,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.User != nil || req.URL.Port() != "" || !mediaHost.MatchString(req.URL.Hostname()) || req.URL.Path != "/videoplayback" {
			return errors.New("Invalid audio redirect")
		}
		return nil
	},
}
var proxyHTTP = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 35 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		DisableCompression:    true,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !isImageURL(req.URL) {
			return errors.New("Invalid image redirect")
		}
		return nil
	},
}

func siteOrigin(c echo.Context) string {
	origin := c.Request().Header.Get("X-Beatbump-Origin")
	u, err := url.Parse(origin)
	if err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" {
		return u.Scheme + "://" + u.Host
	}
	return c.Scheme() + "://" + c.Request().Host
}

func checkedMediaURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" || !mediaHost.MatchString(u.Hostname()) || u.Path != "/videoplayback" {
		return nil, errors.New("Invalid media URL")
	}
	expires, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64)
	if err != nil || expires <= time.Now().Unix() || expires > time.Now().Add(24*time.Hour).Unix() || u.Query().Get("c") == "" {
		return nil, errors.New("Media URL expired or incomplete")
	}
	return u, nil
}

func cloudMediaURL(c echo.Context, raw string) string {
	if os.Getenv("MEDIA_PROXY_KEY") == "" {
		return raw
	}
	if _, err := checkedMediaURL(raw); err != nil {
		return ""
	}
	data := base64.RawURLEncoding.EncodeToString([]byte(raw))
	mac := hmac.New(sha256.New, []byte(os.Getenv("MEDIA_PROXY_KEY")))
	mac.Write([]byte(data))
	ticket := data + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return siteOrigin(c) + "/api/v1/media?ticket=" + ticket
}

func CloudMediaHandler(c echo.Context) error {
	key := os.Getenv("MEDIA_PROXY_KEY")
	ticket := c.QueryParam("ticket")
	if len(ticket) > 16384 || key == "" {
		return c.String(403, "Invalid media ticket")
	}
	parts := strings.Split(ticket, ".")
	if len(parts) != 2 {
		return c.String(403, "Invalid media ticket")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(parts[0]))
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return c.String(403, "Invalid media ticket")
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return c.String(403, "Invalid media ticket")
	}
	u, err := checkedMediaURL(string(data))
	if err != nil {
		return c.String(410, "Media URL expired or invalid. Reload the track.")
	}
	query := u.Query()
	query.Set("host", u.Hostname())
	query.Del("range")
	query.Del("title")
	upstream := strings.TrimRight(os.Getenv("COMPANION_URL"), "/") + "/companion/videoplayback?" + query.Encode()
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, upstream, nil)
	if err != nil {
		return err
	}
	if r := c.Request().Header.Get("Range"); r != "" {
		if !byteRange.MatchString(r) {
			return c.String(416, "Unsupported byte range")
		}
		req.Header.Set("Range", r)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("COMPANION_SECRET_KEY"))
	response, err := proxyHTTP.Do(req)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
	}
	// Some Google clients reject companion's POST-based media fetch. Retry a
	// normal range GET from the same container without exposing the CDN to Safari.
	if err != nil || response.StatusCode >= 400 {
		if response != nil {
			response.Body.Close()
		}
		directRequest, requestErr := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, u.String(), nil)
		if requestErr != nil {
			return requestErr
		}
		directRequest.Header.Set("Range", req.Header.Get("Range"))
		directRequest.Header.Set("User-Agent", "Mozilla/5.0")
		directRequest.Header.Set("Origin", "https://www.youtube.com")
		directRequest.Header.Set("Referer", "https://www.youtube.com/")
		response, err = directMediaHTTP.Do(directRequest)
	}
	if err != nil {
		return c.JSON(502, map[string]string{"error": "The audio service is temporarily unavailable."})
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return c.JSON(response.StatusCode, map[string]string{"error": "The upstream audio service rejected this stream. Reload the track."})
	}
	contentType := strings.ToLower(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if !strings.HasPrefix(contentType, "audio/") && !strings.HasPrefix(contentType, "video/") && contentType != "application/octet-stream" {
		return c.JSON(502, map[string]string{"error": "The upstream returned an invalid audio response. Reload the track."})
	}
	for _, name := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified"} {
		if value := response.Header.Get(name); value != "" {
			c.Response().Header().Set(name, value)
		}
	}
	c.Response().Header().Set("Cache-Control", "no-store")
	c.Response().Header().Set("Accept-Ranges", "bytes")
	status := response.StatusCode
	// Safari expects 206 for its initial bytes=0-1 and subsequent seek requests.
	if req.Header.Get("Range") != "" && response.Header.Get("Content-Range") != "" {
		status = 206
	}
	c.Response().WriteHeader(status)
	if c.Request().Method == http.MethodHead {
		return nil
	}
	_, err = io.Copy(c.Response(), response.Body)
	return err
}

func isImageURL(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	switch u.Hostname() {
	case "i.ytimg.com", "img.youtube.com", "yt3.ggpht.com", "yt3.googleusercontent.com", "lh3.googleusercontent.com", "lh4.googleusercontent.com":
		return true
	}
	return false
}

func CloudImageHandler(c echo.Context) error {
	raw := c.QueryParam("url")
	if c.QueryParams().Has("id") {
		id := c.QueryParam("id")
		if len(id) == 0 || len(id) > 11000 {
			return c.String(400, "Invalid image ID")
		}
		decoded, err := base64.RawURLEncoding.DecodeString(id)
		if err != nil {
			return c.String(400, "Invalid image ID")
		}
		raw = string(decoded)
	}
	u, err := url.Parse(raw)
	if len(raw) > 8192 || err != nil || !isImageURL(u) {
		return c.String(400, "Invalid image URL")
	}
	req, _ := http.NewRequestWithContext(c.Request().Context(), c.Request().Method, u.String(), nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	response, err := proxyHTTP.Do(req)
	if err != nil {
		return c.String(502, "Image unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return c.String(response.StatusCode, "Image unavailable")
	}
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "image/") {
		return c.String(502, "Invalid image response")
	}
	c.Response().Header().Set("Content-Type", response.Header.Get("Content-Type"))
	c.Response().Header().Set("Cache-Control", "public, max-age=86400")
	c.Response().WriteHeader(200)
	if c.Request().Method == http.MethodHead {
		return nil
	}
	_, err = io.Copy(c.Response(), io.LimitReader(response.Body, 8<<20))
	return err
}

// Rewrite CDN image links inside JSON metadata without buffering audio streams.
type CloudJSONSerializer struct{ echo.DefaultJSONSerializer }

func (s CloudJSONSerializer) Serialize(c echo.Context, value interface{}, indent string) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var tree interface{}
	if err := json.Unmarshal(encoded, &tree); err != nil {
		return err
	}
	tree = rewriteImages(tree, siteOrigin(c))
	enc := json.NewEncoder(c.Response())
	if indent != "" {
		enc.SetIndent("", indent)
	}
	return enc.Encode(tree)
}

func rewriteImages(value interface{}, origin string) interface{} {
	switch item := value.(type) {
	case string:
		u, err := url.Parse(item)
		// Upgrade previously stored query URLs when they pass through metadata again.
		if err == nil && u.Path == "/api/v1/image" && u.Query().Has("url") {
			candidate, parseErr := url.Parse(u.Query().Get("url"))
			if parseErr == nil && isImageURL(candidate) {
				u = candidate
				item = candidate.String()
			}
		}
		if err == nil && isImageURL(u) {
			return origin + "/api/v1/image?id=" + base64.RawURLEncoding.EncodeToString([]byte(item))
		}
	case []interface{}:
		for i := range item {
			item[i] = rewriteImages(item[i], origin)
		}
	case map[string]interface{}:
		for k, v := range item {
			item[k] = rewriteImages(v, origin)
		}
	}
	return value
}

func CloudHealthHandler(c echo.Context) error {
	client := &http.Client{Timeout: 3 * time.Second}
	req, _ := http.NewRequestWithContext(c.Request().Context(), "GET", strings.TrimRight(os.Getenv("COMPANION_URL"), "/")+"/healthz", nil)
	response, err := client.Do(req)
	if err != nil {
		return c.JSON(503, map[string]string{"status": "starting", "companion": "unavailable"})
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return c.JSON(503, map[string]string{"status": "starting", "companion": fmt.Sprint(response.StatusCode)})
	}
	return c.JSON(200, map[string]string{"status": "ready", "companion": "ready", "revision": "beatbump-cloudflare-1"})
}
