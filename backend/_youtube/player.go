package _youtube

type PlayerResponse struct {
	ResponseContext struct {
		VisitorData           string `json:"visitorData"`
		ServiceTrackingParams []struct {
			Service string `json:"service"`
			Params  []struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			} `json:"params"`
		} `json:"serviceTrackingParams"`
		MaxAgeSeconds int `json:"maxAgeSeconds"`
	} `json:"responseContext"`
	PlayabilityStatus struct {
		Status          string `json:"status"`
		Reason          string `json:"reason,omitempty"`
		PlayableInEmbed bool   `json:"playableInEmbed"`
		ContextParams   string `json:"contextParams"`
	} `json:"playabilityStatus"`
	StreamingData struct {
		DrmFamilies      string `json:"drmFamilies,omitempty"`
		HlsManifestUrl   string `json:"hlsManifestUrl"`
		ExpiresInSeconds string `json:"expiresInSeconds"`
		Formats          []struct {
			Itag             int    `json:"itag"`
			MimeType         string `json:"mimeType"`
			Bitrate          int    `json:"bitrate"`
			Width            int    `json:"width"`
			Height           int    `json:"height"`
			LastModified     string `json:"lastModified"`
			ContentLength    string `json:"contentLength"`
			Quality          string `json:"quality"`
			Fps              int    `json:"fps"`
			QualityLabel     string `json:"qualityLabel"`
			ProjectionType   string `json:"projectionType"`
			AverageBitrate   int    `json:"averageBitrate"`
			AudioQuality     string `json:"audioQuality"`
			ApproxDurationMs string `json:"approxDurationMs"`
			AudioSampleRate  string `json:"audioSampleRate"`
			AudioChannels    int    `json:"audioChannels"`
			SignatureCipher  string `json:"signatureCipher"`
		} `json:"formats"`
		AdaptiveFormats []struct {
			Itag      int    `json:"itag"`
			MimeType  string `json:"mimeType"`
			Bitrate   int    `json:"bitrate"`
			Width     int    `json:"width,omitempty"`
			Height    int    `json:"height,omitempty"`
			InitRange struct {
				Start string `json:"start"`
				End   string `json:"end"`
			} `json:"initRange"`
			IndexRange struct {
				Start string `json:"start"`
				End   string `json:"end"`
			} `json:"indexRange"`
			LastModified     string `json:"lastModified"`
			ContentLength    string `json:"contentLength"`
			Quality          string `json:"quality"`
			Fps              int    `json:"fps,omitempty"`
			QualityLabel     string `json:"qualityLabel,omitempty"`
			ProjectionType   string `json:"projectionType"`
			AverageBitrate   int    `json:"averageBitrate"`
			ApproxDurationMs string `json:"approxDurationMs"`
			URL              string `json:"url"`
			SignatureCipher  string `json:"signatureCipher"`
			ColorInfo        struct {
				Primaries               string `json:"primaries"`
				TransferCharacteristics string `json:"transferCharacteristics"`
				MatrixCoefficients      string `json:"matrixCoefficients"`
			} `json:"colorInfo,omitempty"`
			HighReplication bool    `json:"highReplication,omitempty"`
			AudioQuality    string  `json:"audioQuality,omitempty"`
			AudioSampleRate string  `json:"audioSampleRate,omitempty"`
			AudioChannels   int     `json:"audioChannels,omitempty"`
			LoudnessDb      float64 `json:"loudnessDb,omitempty"`
		} `json:"adaptiveFormats"`
		ServerAbrStreamingURL string `json:"serverAbrStreamingUrl"`
	} `json:"streamingData"`
	PlaybackTracking struct {
		VideostatsPlaybackURL struct {
			BaseURL string `json:"baseUrl"`
			Headers []struct {
				HeaderType string `json:"headerType"`
			} `json:"headers"`
		} `json:"videostatsPlaybackUrl"`
		VideostatsDelayplayURL struct {
			BaseURL string `json:"baseUrl"`
			Headers []struct {
				HeaderType string `json:"headerType"`
			} `json:"headers"`
		} `json:"videostatsDelayplayUrl"`
		VideostatsWatchtimeURL struct {
			BaseURL string `json:"baseUrl"`
			Headers []struct {
				HeaderType string `json:"headerType"`
			} `json:"headers"`
		} `json:"videostatsWatchtimeUrl"`
		PtrackingURL struct {
			BaseURL string `json:"baseUrl"`
			Headers []struct {
				HeaderType string `json:"headerType"`
			} `json:"headers"`
		} `json:"ptrackingUrl"`
		QoeURL struct {
			BaseURL string `json:"baseUrl"`
			Headers []struct {
				HeaderType string `json:"headerType"`
			} `json:"headers"`
		} `json:"qoeUrl"`
		AtrURL struct {
			BaseURL                 string `json:"baseUrl"`
			ElapsedMediaTimeSeconds int    `json:"elapsedMediaTimeSeconds"`
			Headers                 []struct {
				HeaderType string `json:"headerType"`
			} `json:"headers"`
		} `json:"atrUrl"`
		VideostatsScheduledFlushWalltimeSeconds []int `json:"videostatsScheduledFlushWalltimeSeconds"`
		VideostatsDefaultFlushIntervalSeconds   int   `json:"videostatsDefaultFlushIntervalSeconds"`
	} `json:"playbackTracking"`
	VideoDetails struct {
		VideoID        string `json:"videoId"`
		Title          string `json:"title"`
		LengthSeconds  string `json:"lengthSeconds"`
		ChannelID      string `json:"channelId"`
		IsOwnerViewing bool   `json:"isOwnerViewing"`
		IsCrawlable    bool   `json:"isCrawlable"`
		Thumbnail      struct {
			Thumbnails []struct {
				URL    string `json:"url"`
				Width  int    `json:"width"`
				Height int    `json:"height"`
			} `json:"thumbnails"`
		} `json:"thumbnail"`
		AllowRatings      bool   `json:"allowRatings"`
		Author            string `json:"author"`
		IsPrivate         bool   `json:"isPrivate"`
		IsUnpluggedCorpus bool   `json:"isUnpluggedCorpus"`
		MusicVideoType    string `json:"musicVideoType"`
		IsLiveContent     bool   `json:"isLiveContent"`
	} `json:"videoDetails"`
	PlayerConfig struct {
		AudioConfig struct {
			LoudnessDb              float64 `json:"loudnessDb"`
			PerceptualLoudnessDb    float64 `json:"perceptualLoudnessDb"`
			PlayAudioOnly           bool    `json:"playAudioOnly"`
			EnablePerFormatLoudness bool    `json:"enablePerFormatLoudness"`
		} `json:"audioConfig"`
		StreamSelectionConfig struct {
			MaxBitrate string `json:"maxBitrate"`
		} `json:"streamSelectionConfig"`
		MediaCommonConfig struct {
			DynamicReadaheadConfig struct {
				MaxReadAheadMediaTimeMs int `json:"maxReadAheadMediaTimeMs"`
				MinReadAheadMediaTimeMs int `json:"minReadAheadMediaTimeMs"`
				ReadAheadGrowthRateMs   int `json:"readAheadGrowthRateMs"`
			} `json:"dynamicReadaheadConfig"`
			MediaUstreamerRequestConfig struct {
				VideoPlaybackUstreamerConfig string `json:"videoPlaybackUstreamerConfig"`
			} `json:"mediaUstreamerRequestConfig"`
			UseServerDrivenAbr bool `json:"useServerDrivenAbr"`
		} `json:"mediaCommonConfig"`
		WebPlayerConfig struct {
			UseCobaltTvosDash       bool `json:"useCobaltTvosDash"`
			WebPlayerActionsPorting struct {
				SubscribeCommand struct {
					ClickTrackingParams string `json:"clickTrackingParams"`
					SubscribeEndpoint   struct {
						ChannelIds []string `json:"channelIds"`
						Params     string   `json:"params"`
					} `json:"subscribeEndpoint"`
				} `json:"subscribeCommand"`
				UnsubscribeCommand struct {
					ClickTrackingParams string `json:"clickTrackingParams"`
					UnsubscribeEndpoint struct {
						ChannelIds []string `json:"channelIds"`
						Params     string   `json:"params"`
					} `json:"unsubscribeEndpoint"`
				} `json:"unsubscribeCommand"`
				AddToWatchLaterCommand struct {
					ClickTrackingParams  string `json:"clickTrackingParams"`
					PlaylistEditEndpoint struct {
						PlaylistID string `json:"playlistId"`
						Actions    []struct {
							AddedVideoID string `json:"addedVideoId"`
							Action       string `json:"action"`
						} `json:"actions"`
					} `json:"playlistEditEndpoint"`
				} `json:"addToWatchLaterCommand"`
				RemoveFromWatchLaterCommand struct {
					ClickTrackingParams  string `json:"clickTrackingParams"`
					PlaylistEditEndpoint struct {
						PlaylistID string `json:"playlistId"`
						Actions    []struct {
							Action         string `json:"action"`
							RemovedVideoID string `json:"removedVideoId"`
						} `json:"actions"`
					} `json:"playlistEditEndpoint"`
				} `json:"removeFromWatchLaterCommand"`
			} `json:"webPlayerActionsPorting"`
		} `json:"webPlayerConfig"`
	} `json:"playerConfig"`
	Storyboards struct {
		PlayerStoryboardSpecRenderer struct {
			Spec             string `json:"spec"`
			RecommendedLevel int    `json:"recommendedLevel"`
		} `json:"playerStoryboardSpecRenderer"`
	} `json:"storyboards"`
	Microformat struct {
		MicroformatDataRenderer struct {
			URLCanonical string `json:"urlCanonical"`
			Title        string `json:"title"`
			Description  string `json:"description"`
			Thumbnail    struct {
				Thumbnails []struct {
					URL    string `json:"url"`
					Width  int    `json:"width"`
					Height int    `json:"height"`
				} `json:"thumbnails"`
			} `json:"thumbnail"`
			SiteName           string   `json:"siteName"`
			AppName            string   `json:"appName"`
			AndroidPackage     string   `json:"androidPackage"`
			IosAppStoreID      string   `json:"iosAppStoreId"`
			IosAppArguments    string   `json:"iosAppArguments"`
			OgType             string   `json:"ogType"`
			URLApplinksIos     string   `json:"urlApplinksIos"`
			URLApplinksAndroid string   `json:"urlApplinksAndroid"`
			URLTwitterIos      string   `json:"urlTwitterIos"`
			URLTwitterAndroid  string   `json:"urlTwitterAndroid"`
			TwitterCardType    string   `json:"twitterCardType"`
			TwitterSiteHandle  string   `json:"twitterSiteHandle"`
			SchemaDotOrgType   string   `json:"schemaDotOrgType"`
			Noindex            bool     `json:"noindex"`
			Unlisted           bool     `json:"unlisted"`
			Paid               bool     `json:"paid"`
			FamilySafe         bool     `json:"familySafe"`
			Tags               []string `json:"tags"`
			AvailableCountries []string `json:"availableCountries"`
			PageOwnerDetails   struct {
				Name              string `json:"name"`
				ExternalChannelID string `json:"externalChannelId"`
				YoutubeProfileURL string `json:"youtubeProfileUrl"`
			} `json:"pageOwnerDetails"`
			VideoDetails struct {
				ExternalVideoID string `json:"externalVideoId"`
				DurationSeconds string `json:"durationSeconds"`
				DurationIso8601 string `json:"durationIso8601"`
			} `json:"videoDetails"`
			LinkAlternates []struct {
				HrefURL       string `json:"hrefUrl"`
				Title         string `json:"title,omitempty"`
				AlternateType string `json:"alternateType,omitempty"`
			} `json:"linkAlternates"`
			ViewCount   string `json:"viewCount"`
			PublishDate string `json:"publishDate"`
			Category    string `json:"category"`
			UploadDate  string `json:"uploadDate"`
		} `json:"microformatDataRenderer"`
	} `json:"microformat"`
	TrackingParams string `json:"trackingParams"`
	Attestation    struct {
		PlayerAttestationRenderer struct {
			Challenge    string `json:"challenge"`
			BotguardData struct {
				Program            string `json:"program"`
				InterpreterSafeURL struct {
					PrivateDoNotAccessOrElseTrustedResourceURLWrappedValue string `json:"privateDoNotAccessOrElseTrustedResourceUrlWrappedValue"`
				} `json:"interpreterSafeUrl"`
				ServerEnvironment int `json:"serverEnvironment"`
			} `json:"botguardData"`
		} `json:"playerAttestationRenderer"`
	} `json:"attestation"`
	AdBreakHeartbeatParams string `json:"adBreakHeartbeatParams"`
}
